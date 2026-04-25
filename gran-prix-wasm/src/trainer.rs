//! Online Trainer for Supervised Learning in WASM.
//!
//! Uses [`NetworkDef`] from the core crate for architecture definition,
//! replacing the previous ad-hoc `WasmArchitecture` JSON format.

use wasm_bindgen::prelude::*;
use std::cell::RefCell;
use gran_prix::{Tensor, GPError, NodeId};
use gran_prix::graph::Graph;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::loss::Loss;
use gran_prix::network_def::{NetworkDef, LayerDef};
use gran_prix::layers::ActivationType;
use gran_prix::params::ParamId;

#[wasm_bindgen]
pub struct Trainer {
    graph: RefCell<Graph>,
    input_node: usize,
    output_node: usize,
    input_dim: usize,
    output_dim: usize,
    input_tensor: RefCell<Tensor>,
    optimizer: RefCell<gran_prix::optim::Adam>,
    net_json: String,
}

/// Helper: convert GPError to JsValue.
fn js_err(e: GPError) -> JsValue {
    JsValue::from_str(&e.to_string())
}

#[wasm_bindgen]
impl Trainer {
    /// Creates a trainer with a simple MLP: Input → (Linear+Tanh)×N → Linear(1).
    ///
    /// This is the constructor used by the Playground for binary classification.
    #[wasm_bindgen(constructor)]
    pub fn new(input_dim: usize, hidden_layers: Vec<usize>) -> Result<Trainer, JsValue> {
        let net = NetworkDef::mlp(
            input_dim,
            &hidden_layers,
            1, // single output for binary classification
            ActivationType::Tanh,
            None, // no output activation (logits — BCE with logits applies sigmoid)
        );

        let output_dim = net.output_dim();
        let net_json = net.to_json().map_err(js_err)?;
        let compiled = net.compile(Box::new(CPUBackend)).map_err(js_err)?;
        let input_node = compiled.input_node.0;
        let output_node = compiled.output_node.0;

        Ok(Trainer {
            graph: RefCell::new(compiled.graph),
            input_node,
            output_node,
            input_dim,
            output_dim,
            input_tensor: RefCell::new(Tensor::new_zeros(&[1, input_dim])),
            optimizer: RefCell::new(gran_prix::optim::Adam::new(0.01)),
            net_json,
        })
    }

    /// Creates a trainer from a [`NetworkDef`] JSON string.
    ///
    /// This replaces the old `WasmArchitecture` format. The JSON schema
    /// is defined by the core `NetworkDef` type:
    ///
    /// ```json
    /// {
    ///   "input_dim": 2,
    ///   "layers": [
    ///     { "type": "linear", "in_features": 2, "out_features": 8 },
    ///     { "type": "activation", "function": "relu" },
    ///     { "type": "linear", "in_features": 8, "out_features": 1 }
    ///   ]
    /// }
    /// ```
    #[wasm_bindgen(js_name = fromNetworkDef)]
    pub fn from_network_def(json: &str) -> Result<Trainer, JsValue> {
        let net = NetworkDef::from_json(json).map_err(js_err)?;
        let input_dim = net.input_dim;
        let output_dim = net.output_dim();
        // Re-serialize from the parsed NetworkDef so the stored JSON is canonical
        // (whitespace-normalized) and provably round-trip-safe.
        let net_json = net.to_json().map_err(js_err)?;
        let compiled = net.compile(Box::new(CPUBackend)).map_err(js_err)?;

        Ok(Trainer {
            graph: RefCell::new(compiled.graph),
            input_node: compiled.input_node.0,
            output_node: compiled.output_node.0,
            input_dim,
            output_dim,
            input_tensor: RefCell::new(Tensor::new_zeros(&[1, input_dim])),
            optimizer: RefCell::new(gran_prix::optim::Adam::new(0.01)),
            net_json,
        })
    }

    /// Backward-compatible: parses the old `WasmArchitecture` JSON format
    /// by converting it to a [`NetworkDef`] internally.
    ///
    /// Supported layer types: Input, Linear, Activation (relu/sigmoid/tanh),
    /// Rnn, Gru, Output, Dropout (passthrough), Batchnorm (passthrough).
    #[wasm_bindgen(js_name = fromArchitecture)]
    pub fn from_architecture(json: &str) -> Result<Trainer, JsValue> {
        let net_def = convert_legacy_architecture(json)?;
        let input_dim = net_def.input_dim;
        let output_dim = net_def.output_dim();
        // The canonical NetworkDef JSON — callers can use this to round-trip
        // even though they passed a legacy WasmArchitecture format.
        let net_json = net_def.to_json().map_err(js_err)?;
        let compiled = net_def.compile(Box::new(CPUBackend)).map_err(js_err)?;

        Ok(Trainer {
            graph: RefCell::new(compiled.graph),
            input_node: compiled.input_node.0,
            output_node: compiled.output_node.0,
            input_dim,
            output_dim,
            input_tensor: RefCell::new(Tensor::new_zeros(&[1, input_dim])),
            optimizer: RefCell::new(gran_prix::optim::Adam::new(0.01)),
            net_json,
        })
    }

    // ── Weight Access ──────────────────────────────────────────────────────

    pub fn get_weights(&self) -> Result<Vec<f32>, JsValue> {
        self.graph.borrow().params().export_flat().map_err(js_err)
    }

    pub fn get_gradient_norms(&self) -> Result<Vec<f32>, JsValue> {
        self.graph.borrow().params().gradient_norms().map_err(js_err)
    }

    pub fn import_weights(&self, weights: &[f32]) -> Result<(), JsValue> {
        self.graph.borrow_mut().params_mut().import_flat(weights).map_err(js_err)
    }

    // ── Training ───────────────────────────────────────────────────────────

    pub fn train_batch(&self, inputs: Vec<f32>, targets: Vec<f32>, lr: f32) -> Result<f32, JsValue> {
        let mut graph = self.graph.borrow_mut();

        let batch_size = targets.len();
        if batch_size == 0 { return Ok(0.0); }
        if inputs.len() != batch_size * self.input_dim {
            return Err(JsValue::from_str("Input vector size mismatch"));
        }

        let mut total_loss = 0.0;
        let target = NodeId(self.output_node);
        let order = graph.topological_sort(target).map_err(js_err)?;

        graph.clear_gradients();

        for i in 0..batch_size {
            // Inject input
            {
                let mut input_buffer = self.input_tensor.borrow_mut();
                if let Ok(slice) = input_buffer.as_slice_mut() {
                    let start = i * self.input_dim;
                    for d in 0..self.input_dim {
                        slice[d] = inputs[start + d];
                    }
                }
                if let Some(gran_prix::graph::Node::Input(ref mut t)) = graph.nodes_mut().get_mut(self.input_node) {
                    t.copy_from(&input_buffer).map_err(js_err)?;
                }
            }

            let result = graph.execute_with_order(&order, target).map_err(js_err)?;

            let target_tensor = Tensor::from_shape_vec(&[1, 1], vec![targets[i]]).unwrap();
            let loss_fn = gran_prix::loss::BCEWithLogits;

            let mut grad = loss_fn.gradient(&result, &target_tensor).map_err(js_err)?;
            grad.map_inplace(|v| *v /= batch_size as f32).unwrap();

            total_loss += loss_fn.calculate(&result, &target_tensor).map_err(js_err)?;

            graph.backward(NodeId(self.output_node), grad).map_err(js_err)?;
        }

        use gran_prix::optim::Optimizer;
        let mut opt = self.optimizer.borrow_mut();
        opt.lr = lr;
        opt.step_graph(&mut graph).map_err(js_err)?;

        Ok(total_loss / batch_size as f32)
    }

    pub fn train_step(&self, features: Vec<f32>, target_val: f32, lr: f32) -> Result<f32, JsValue> {
        self.train_batch(features, vec![target_val], lr)
    }

    // ── Inference ──────────────────────────────────────────────────────────

    pub fn predict(&self, features: Vec<f32>) -> Result<f32, JsValue> {
        if features.len() != self.input_dim {
            return Err(JsValue::from_str("Features dimension mismatch"));
        }
        let mut graph = self.graph.borrow_mut();
        {
            let mut input_buffer = self.input_tensor.borrow_mut();
            let slice = input_buffer.as_slice_mut().map_err(js_err)?;
            for d in 0..self.input_dim {
                slice[d] = features[d];
            }
            if let Some(gran_prix::graph::Node::Input(ref mut t)) = graph.nodes_mut().get_mut(self.input_node) {
                t.copy_from(&input_buffer).map_err(js_err)?;
            }
        }

        let result = graph.execute(NodeId(self.output_node)).map_err(js_err)?;
        let slice = result.as_slice().map_err(js_err)?;
        let logit = slice[0];
        Ok(1.0 / (1.0 + (-logit).exp()))
    }

    /// Batched inference over a flat input buffer.
    ///
    /// The expected layout is row-major: `inputs[i * input_dim + d]` is the
    /// `d`-th feature of the `i`-th sample. The output is laid out the same way
    /// over `output_dim`. Sigmoid is applied element-wise to the network's
    /// raw logits, matching the BCE-with-logits training objective used by
    /// [`train_batch`].
    ///
    /// Performance: the topological order is computed once before the loop
    /// and reused across all samples. Crossing the JS↔WASM boundary happens
    /// twice per call (one input copy, one output copy) regardless of
    /// `batch_size`. For DOM classification with thousands of nodes per page,
    /// this is the expected fast path.
    #[wasm_bindgen(js_name = predictBatch)]
    pub fn predict_batch(&self, inputs: Vec<f32>, batch_size: usize) -> Result<Vec<f32>, JsValue> {
        if batch_size == 0 {
            return Ok(Vec::new());
        }
        let expected_input_len = batch_size
            .checked_mul(self.input_dim)
            .ok_or_else(|| JsValue::from_str("predict_batch: batch_size * input_dim overflow"))?;
        if inputs.len() != expected_input_len {
            return Err(JsValue::from_str(&format!(
                "predict_batch: inputs length {} != batch_size {} * input_dim {}",
                inputs.len(), batch_size, self.input_dim
            )));
        }

        let mut graph = self.graph.borrow_mut();
        let target = NodeId(self.output_node);

        // Sync params into the engine cache once, then reuse the topological
        // order across every sample. `execute_with_order` skips the re-sort
        // that `execute()` does on each call.
        graph.sync_params().map_err(js_err)?;
        let order = graph.topological_sort(target).map_err(js_err)?;

        let mut outputs = Vec::with_capacity(batch_size * self.output_dim);

        for i in 0..batch_size {
            {
                let mut input_buffer = self.input_tensor.borrow_mut();
                let slice = input_buffer.as_slice_mut().map_err(js_err)?;
                let start = i * self.input_dim;
                for d in 0..self.input_dim {
                    slice[d] = inputs[start + d];
                }
                if let Some(gran_prix::graph::Node::Input(ref mut t)) = graph.nodes_mut().get_mut(self.input_node) {
                    t.copy_from(&input_buffer).map_err(js_err)?;
                }
            }

            let result = graph.execute_with_order(&order, target).map_err(js_err)?;
            let result_slice = result.as_slice().map_err(js_err)?;

            // The trainer's loss is BCEWithLogits: it applies sigmoid internally
            // during gradient computation, so the network's output node is a logit.
            // Apply sigmoid here to return a probability — matching `predict()`.
            for &logit in result_slice.iter().take(self.output_dim) {
                outputs.push(1.0 / (1.0 + (-logit).exp()));
            }
        }

        Ok(outputs)
    }

    // ── Architecture introspection ─────────────────────────────────────────

    /// Returns the canonical `NetworkDef` JSON used to construct this trainer.
    ///
    /// The pair `(network_def_json(), get_weights())` is the canonical
    /// serialization contract for this trainer — sufficient to reconstruct
    /// it from scratch via [`from_network_def`] + [`import_weights`]. We do
    /// **not** serialize the live `Graph`, because there is no end-to-end
    /// test guaranteeing that path preserves trained-model behavior; the
    /// `(NetworkDef, flat weights)` path uses only primitives that are
    /// covered by unit tests.
    #[wasm_bindgen(js_name = networkDefJson)]
    pub fn network_def_json(&self) -> String {
        self.net_json.clone()
    }

    /// Returns the input feature dimensionality.
    #[wasm_bindgen(js_name = inputDim)]
    pub fn input_dim(&self) -> usize {
        self.input_dim
    }

    /// Returns the output dimensionality (1 for binary classification).
    #[wasm_bindgen(js_name = outputDim)]
    pub fn output_dim(&self) -> usize {
        self.output_dim
    }

    // ── Param freeze (transfer-learning support) ───────────────────────────

    /// Returns the total number of trainable parameter tensors registered
    /// in the underlying `ParamStore`.
    ///
    /// For a Linear layer this is 2 (weight + bias); for activation/dropout
    /// layers it is 0; for BatchNorm it is 2. The order of registration
    /// follows the order of layers in the `NetworkDef`.
    #[wasm_bindgen(js_name = paramCount)]
    pub fn param_count(&self) -> usize {
        self.graph.borrow().params().len()
    }

    /// Replaces the frozen-parameter set with exactly the given indices.
    ///
    /// All other parameters are explicitly unfrozen. This is the recommended
    /// API for the backbone+head pattern: pass the indices that belong to the
    /// backbone, leave the head trainable.
    ///
    /// All indices are validated up front; on any out-of-bounds index the
    /// store is left unchanged and an error is returned.
    #[wasm_bindgen(js_name = setFrozenParams)]
    pub fn set_frozen_params(&self, indices: Vec<usize>) -> Result<(), JsValue> {
        let mut graph = self.graph.borrow_mut();
        let n = graph.params().len();
        for &i in &indices {
            if i >= n {
                return Err(JsValue::from_str(&format!(
                    "setFrozenParams: index {} out of bounds (param_count = {})", i, n
                )));
            }
        }
        let store = graph.params_mut();
        for i in 0..n {
            store.unfreeze(ParamId(i));
        }
        for &i in &indices {
            store.freeze(ParamId(i));
        }
        Ok(())
    }

    /// Freezes a single parameter by index.
    #[wasm_bindgen(js_name = freezeParam)]
    pub fn freeze_param(&self, index: usize) -> Result<(), JsValue> {
        let mut graph = self.graph.borrow_mut();
        let n = graph.params().len();
        if index >= n {
            return Err(JsValue::from_str(&format!(
                "freezeParam: index {} out of bounds (param_count = {})", index, n
            )));
        }
        graph.params_mut().freeze(ParamId(index));
        Ok(())
    }

    /// Unfreezes a single parameter by index.
    #[wasm_bindgen(js_name = unfreezeParam)]
    pub fn unfreeze_param(&self, index: usize) -> Result<(), JsValue> {
        let mut graph = self.graph.borrow_mut();
        let n = graph.params().len();
        if index >= n {
            return Err(JsValue::from_str(&format!(
                "unfreezeParam: index {} out of bounds (param_count = {})", index, n
            )));
        }
        graph.params_mut().unfreeze(ParamId(index));
        Ok(())
    }

    /// Returns a boolean vector of length `param_count` indicating which
    /// parameters are currently frozen.
    #[wasm_bindgen(js_name = frozenMask)]
    pub fn frozen_mask(&self) -> Vec<u8> {
        let graph = self.graph.borrow();
        let n = graph.params().len();
        (0..n)
            .map(|i| if graph.params().is_frozen(ParamId(i)) { 1u8 } else { 0u8 })
            .collect()
    }

    pub fn get_decision_boundary(&self, resolution: usize, feature_map: js_sys::Function) -> Result<Vec<f32>, JsValue> {
        let mut graph = self.graph.borrow_mut();
        let target = NodeId(self.output_node);
        graph.sync_params().map_err(js_err)?;

        let order = graph.topological_sort(target).map_err(js_err)?;

        let mut results = Vec::with_capacity(resolution * resolution);
        for j in 0..resolution {
            for i in 0..resolution {
                let x = (i as f32 / resolution as f32) * 2.0 - 1.0;
                let y = (j as f32 / resolution as f32) * 2.0 - 1.0;

                let js_x = JsValue::from_f64(x as f64);
                let js_y = JsValue::from_f64(y as f64);
                let expanded = feature_map.call2(&JsValue::NULL, &js_x, &js_y)?
                    .dyn_into::<js_sys::Float32Array>()?;
                let features = expanded.to_vec();

                {
                    let mut input_buffer = self.input_tensor.borrow_mut();
                    if let Ok(slice) = input_buffer.as_slice_mut() {
                        for d in 0..self.input_dim {
                            slice[d] = features[d];
                        }
                    }
                    if let Some(gran_prix::graph::Node::Input(ref mut t)) = graph.nodes_mut().get_mut(self.input_node) {
                        t.copy_from(&input_buffer).map_err(js_err)?;
                    }
                }

                let result = graph.execute_with_order(&order, target).map_err(js_err)?;
                let slice = result.as_slice().map_err(js_err)?;
                let logit = slice[0];
                results.push(1.0 / (1.0 + (-logit).exp()));
            }
        }
        Ok(results)
    }
}

// ── Legacy Architecture Conversion ─────────────────────────────────────────
//
// Converts the old WasmArchitecture JSON format (used by Network Builder v2)
// to the canonical NetworkDef format. This preserves backward compatibility
// while allowing the frontend to migrate at its own pace.

use serde::Deserialize;

#[derive(Deserialize)]
struct LegacyArchitecture {
    layers: Vec<LegacyLayer>,
    connections: Vec<LegacyConnection>,
    #[serde(rename = "inputDim")]
    input_dim: usize,
    #[serde(rename = "outputDim")]
    #[allow(dead_code)]
    output_dim: usize,
}

#[derive(Deserialize)]
struct LegacyLayer {
    id: String,
    #[serde(rename = "type")]
    layer_type: String,
    params: LegacyParams,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct LegacyParams {
    input_size: Option<usize>,
    output_size: Option<usize>,
    hidden_size: Option<usize>,
    activation_type: Option<String>,
}

#[derive(Deserialize)]
struct LegacyConnection {
    from: String,
    to: String,
}

/// Converts the old `WasmArchitecture` JSON to a `NetworkDef`.
///
/// Follows connections in topological order, skipping Input/Output/Dropout/Batchnorm.
fn convert_legacy_architecture(json: &str) -> Result<NetworkDef, JsValue> {
    let arch: LegacyArchitecture = serde_json::from_str(json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse architecture: {}", e)))?;

    // Find input layer
    let input_layer = arch.layers.iter()
        .find(|l| l.layer_type == "input")
        .ok_or_else(|| JsValue::from_str("No input layer found"))?;

    // BFS from input following connections
    let mut processed = vec![input_layer.id.clone()];
    let mut queue: Vec<String> = arch.connections.iter()
        .filter(|c| c.from == input_layer.id)
        .map(|c| c.to.clone())
        .collect();

    let mut layer_defs = Vec::new();
    let mut current_dim = arch.input_dim;

    while !queue.is_empty() {
        let layer_id = queue.remove(0);
        if processed.contains(&layer_id) { continue; }

        let layer = arch.layers.iter()
            .find(|l| l.id == layer_id)
            .ok_or_else(|| JsValue::from_str(&format!("Layer {} not found", layer_id)))?;

        match layer.layer_type.as_str() {
            "linear" => {
                let in_f = layer.params.input_size.unwrap_or(current_dim);
                let out_f = layer.params.output_size
                    .ok_or_else(|| JsValue::from_str("Linear layer missing outputSize"))?;
                layer_defs.push(LayerDef::Linear { in_features: in_f, out_features: out_f });
                current_dim = out_f;
            }
            "activation" => {
                let act_str = layer.params.activation_type.as_deref().unwrap_or("relu");
                let function = match act_str {
                    "relu" => ActivationType::ReLU,
                    "sigmoid" => ActivationType::Sigmoid,
                    "tanh" => ActivationType::Tanh,
                    "softmax" => ActivationType::Softmax,
                    _ => return Err(JsValue::from_str(&format!("Unknown activation: {}", act_str))),
                };
                layer_defs.push(LayerDef::Activation { function });
            }
            "rnn" => {
                let in_s = layer.params.input_size.unwrap_or(current_dim);
                let h_s = layer.params.hidden_size
                    .ok_or_else(|| JsValue::from_str("RNN layer missing hiddenSize"))?;
                layer_defs.push(LayerDef::Rnn { input_size: in_s, hidden_size: h_s });
                current_dim = h_s;
            }
            "gru" => {
                let in_s = layer.params.input_size.unwrap_or(current_dim);
                let h_s = layer.params.hidden_size
                    .ok_or_else(|| JsValue::from_str("GRU layer missing hiddenSize"))?;
                layer_defs.push(LayerDef::Gru { input_size: in_s, hidden_size: h_s });
                current_dim = h_s;
            }
            "output" | "dropout" | "batchnorm" | "input" => {
                // Skip — these don't produce computation nodes
            }
            other => {
                return Err(JsValue::from_str(&format!("Unknown layer type: {}", other)));
            }
        }

        processed.push(layer_id.clone());
        for conn in &arch.connections {
            if conn.from == layer_id && !queue.contains(&conn.to) && !processed.contains(&conn.to) {
                queue.push(conn.to.clone());
            }
        }
    }

    if layer_defs.is_empty() {
        return Err(JsValue::from_str("Architecture produced no layers"));
    }

    Ok(NetworkDef::new(arch.input_dim, layer_defs))
}
