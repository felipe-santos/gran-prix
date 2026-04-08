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
use gran_prix::network_def::{NetworkDef, LayerDef, ActivationDef};

#[wasm_bindgen]
pub struct Trainer {
    graph: RefCell<Graph>,
    input_node: usize,
    output_node: usize,
    input_dim: usize,
    input_tensor: RefCell<Tensor>,
    optimizer: RefCell<gran_prix::optim::Adam>,
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
            ActivationDef::Tanh,
            None, // no output activation (logits — BCE with logits applies sigmoid)
        );

        let compiled = net.compile(Box::new(CPUBackend)).map_err(js_err)?;
        let input_node = compiled.input_node.0;
        let output_node = compiled.output_node.0;

        Ok(Trainer {
            graph: RefCell::new(compiled.graph),
            input_node,
            output_node,
            input_dim,
            input_tensor: RefCell::new(Tensor::new_zeros(&[1, input_dim])),
            optimizer: RefCell::new(gran_prix::optim::Adam::new(0.01)),
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
        let compiled = net.compile(Box::new(CPUBackend)).map_err(js_err)?;

        Ok(Trainer {
            graph: RefCell::new(compiled.graph),
            input_node: compiled.input_node.0,
            output_node: compiled.output_node.0,
            input_dim,
            input_tensor: RefCell::new(Tensor::new_zeros(&[1, input_dim])),
            optimizer: RefCell::new(gran_prix::optim::Adam::new(0.01)),
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
        let compiled = net_def.compile(Box::new(CPUBackend)).map_err(js_err)?;

        Ok(Trainer {
            graph: RefCell::new(compiled.graph),
            input_node: compiled.input_node.0,
            output_node: compiled.output_node.0,
            input_dim,
            input_tensor: RefCell::new(Tensor::new_zeros(&[1, input_dim])),
            optimizer: RefCell::new(gran_prix::optim::Adam::new(0.01)),
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
                    "relu" => ActivationDef::ReLU,
                    "sigmoid" => ActivationDef::Sigmoid,
                    "tanh" => ActivationDef::Tanh,
                    "softmax" => ActivationDef::Softmax,
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
