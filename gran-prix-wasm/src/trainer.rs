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

/// Loss function used by a [`Trainer`]. Auto-detected from the
/// underlying [`NetworkDef`]'s output dimension at construction time:
/// `output_dim == 1` → `BinaryCrossEntropy`, otherwise
/// `CategoricalCrossEntropy`. Determines:
///
///  - Which loss is used in [`train_batch`] / [`train_batch_multi_class`]
///  - How [`predict_probs`] interprets logits (sigmoid vs row-softmax)
///  - Which methods are valid (binary methods error on multi-class
///    trainers and vice versa)
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LossKind {
    /// Binary classification head — single-logit output, sigmoid for
    /// inference, BCE-with-logits for training.
    BinaryCrossEntropy = 0,
    /// Multi-class classification head — `K`-logit output, row-wise
    /// softmax for inference, CrossEntropy-with-logits for training.
    CategoricalCrossEntropy = 1,
}

impl LossKind {
    /// Auto-detection rule used by `Trainer` constructors that don't
    /// take an explicit `LossKind`. Centralized here so the rule has
    /// one definition and one test surface.
    ///
    /// **Caveats.** Callers who want a 2-class problem expressed as
    /// two independent binary heads (`output_dim == 2`,
    /// `BinaryCrossEntropy`) must use the explicit constructor
    /// [`Trainer::from_network_def_with_loss`]; the auto-detection
    /// rule chooses `CategoricalCrossEntropy` for any
    /// `output_dim > 1`, which is the right default for the common
    /// case (multi-class softmax) but not the only valid choice.
    fn from_output_dim(output_dim: usize) -> Self {
        if output_dim == 1 {
            LossKind::BinaryCrossEntropy
        } else {
            LossKind::CategoricalCrossEntropy
        }
    }
}

/// Validates that the network's output layer is compatible with the
/// chosen `LossKind`. Returns an error if the terminal activation
/// would compose incorrectly with the loss's gradient computation:
///
///  - `BinaryCrossEntropy` uses `BCEWithLogits` (applies sigmoid
///    internally during the gradient calculation). A network ending
///    in `Sigmoid` would apply sigmoid twice — output of the
///    network would no longer be a logit.
///  - `CategoricalCrossEntropy` uses `CrossEntropyWithLogits`
///    (applies softmax internally). A network ending in `Softmax`
///    would apply softmax twice — gradient computation breaks.
///
/// The check is conservative: it only rejects the unambiguous-bug
/// case of a terminal saturating activation that the corresponding
/// loss function already applies. A user who intentionally builds a
/// network with a non-terminal sigmoid (e.g., as a hidden activation)
/// is not affected.
fn validate_loss_compat(net: &NetworkDef, kind: LossKind) -> Result<(), String> {
    let last = match net.layers.last() {
        Some(l) => l,
        None => return Ok(()), // empty network — let `compile` reject this
    };
    if let LayerDef::Activation { function } = last {
        match (function, kind) {
            (ActivationType::Sigmoid, LossKind::BinaryCrossEntropy) => {
                return Err(
                    "Trainer with LossKind::BinaryCrossEntropy expects raw logits as the \
                     network's output, but the architecture ends in Sigmoid. BCEWithLogits \
                     applies sigmoid internally; remove the trailing Sigmoid activation."
                        .to_string(),
                );
            }
            (ActivationType::Softmax, LossKind::CategoricalCrossEntropy) => {
                return Err(
                    "Trainer with LossKind::CategoricalCrossEntropy expects raw logits as \
                     the network's output, but the architecture ends in Softmax. \
                     CrossEntropyWithLogits applies softmax internally; remove the trailing \
                     Softmax activation."
                        .to_string(),
                );
            }
            _ => {}
        }
    }
    Ok(())
}

/// Runs a single batched forward pass on `graph` and returns the
/// raw logit values from the output node as a flat `Vec<f32>`.
///
/// This is the shared core of `predict_batch` and `predict_probs_batch`.
/// Centralizing the snapshot/restore lets both methods present the
/// same externally-observable contract: at exit, the input node holds
/// **exactly** the tensor it held at entry — same shape, same values.
/// Restoration runs on both the success and the error path; an error
/// during `execute` does not leave the graph's input in a half-modified
/// state.
fn batched_forward_logits(
    graph: &mut Graph,
    input_node: usize,
    output_node: NodeId,
    input_dim: usize,
    batch_size: usize,
    inputs: Vec<f32>,
) -> Result<Vec<f32>, JsValue> {
    // Snapshot the original input tensor so we can restore it
    // bit-for-bit at exit. Tiny clone — the input is `[1, input_dim]`
    // for a fresh `Trainer`, and even after `train_batch`'s copy-in
    // it's bounded by a single sample.
    let original_input = match graph.nodes().get(input_node) {
        Some(gran_prix::graph::Node::Input(t)) => t.clone(),
        _ => return Err(JsValue::from_str("batched forward: input node not Input")),
    };

    // Widen the input node for the batched forward.
    let batch_tensor =
        Tensor::from_shape_vec(&[batch_size, input_dim], inputs).map_err(js_err)?;
    if let Some(gran_prix::graph::Node::Input(t)) = graph.nodes_mut().get_mut(input_node) {
        *t = batch_tensor;
    }
    graph.clear_values();

    let exec_result = graph.execute(output_node);

    // Restore — runs on success and error paths.
    if let Some(gran_prix::graph::Node::Input(t)) = graph.nodes_mut().get_mut(input_node) {
        *t = original_input;
    }
    graph.clear_values();

    let result = exec_result.map_err(js_err)?;
    let logits = result.as_slice().map_err(js_err)?.to_vec();
    Ok(logits)
}

/// Applies the output activation that corresponds to a [`LossKind`].
/// Splits the flat logit buffer into rows of length `output_dim` and
/// applies sigmoid (binary) or numerically-stable softmax (multi-class).
fn apply_output_activation(logits: &[f32], output_dim: usize, kind: LossKind) -> Vec<f32> {
    let mut out = Vec::with_capacity(logits.len());
    match kind {
        LossKind::BinaryCrossEntropy => {
            // Each output is independently sigmoid-mapped; multi-output
            // here means independent binary heads, which we don't
            // currently use but the code is unambiguous.
            for &l in logits {
                out.push(1.0 / (1.0 + (-l).exp()));
            }
        }
        LossKind::CategoricalCrossEntropy => {
            // Row-wise softmax with `max - x` trick for numerical
            // stability. Same algorithm as
            // `CrossEntropyWithLogits::gradient` in the core crate.
            let rows = logits.len() / output_dim;
            for r in 0..rows {
                let start = r * output_dim;
                let row = &logits[start..start + output_dim];
                let max_val = row.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
                let exp_row: Vec<f32> = row.iter().map(|&v| (v - max_val).exp()).collect();
                let sum: f32 = exp_row.iter().sum::<f32>().max(1e-10);
                for e in exp_row {
                    out.push(e / sum);
                }
            }
        }
    }
    out
}

#[wasm_bindgen]
pub struct Trainer {
    graph: RefCell<Graph>,
    input_node: usize,
    output_node: usize,
    input_dim: usize,
    output_dim: usize,
    input_tensor: RefCell<Tensor>,
    optimizer: RefCell<gran_prix::optim::Adam>,
    /// Canonical `NetworkDef` JSON used to compile this trainer.
    /// Stored once at construction so callers can read it back via
    /// [`network_def_json`] and persist the architecture alongside
    /// flat weights — the canonical serialization contract.
    net_json: String,
    /// Loss function selected at construction based on the
    /// `NetworkDef`'s output dimension. Determines which `train_*` /
    /// `predict_*` methods are valid; using a binary method on a
    /// multi-class trainer (or vice versa) returns an error rather
    /// than silently producing wrong outputs.
    loss_kind: LossKind,
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
        Self::build(net, LossKind::BinaryCrossEntropy)
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
        let loss_kind = LossKind::from_output_dim(net.output_dim());
        Self::build(net, loss_kind)
    }

    /// Like [`from_network_def`], but with an explicit `loss_kind`
    /// instead of auto-detection from `output_dim`. Use this when the
    /// auto-detection rule isn't right — e.g., a network with
    /// `output_dim == 2` that the caller wants to treat as two
    /// independent binary heads (`BinaryCrossEntropy`) rather than a
    /// 2-class softmax (`CategoricalCrossEntropy`).
    ///
    /// Errors if the terminal activation in the architecture is
    /// incompatible with the chosen loss (see `validate_loss_compat`).
    #[wasm_bindgen(js_name = fromNetworkDefWithLoss)]
    pub fn from_network_def_with_loss(
        json: &str,
        loss_kind: LossKind,
    ) -> Result<Trainer, JsValue> {
        let net = NetworkDef::from_json(json).map_err(js_err)?;
        Self::build(net, loss_kind)
    }

    /// Internal builder shared by all public constructors. Centralizes
    /// the validation, JSON snapshot, and graph compilation so the
    /// invariants (loss/architecture compatibility, canonical JSON,
    /// pre-allocated input buffer) hold uniformly across construction
    /// paths.
    fn build(net: NetworkDef, loss_kind: LossKind) -> Result<Trainer, JsValue> {
        validate_loss_compat(&net, loss_kind).map_err(|e| JsValue::from_str(&e))?;

        let input_dim = net.input_dim;
        let output_dim = net.output_dim();
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
            loss_kind,
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
        if self.loss_kind != LossKind::BinaryCrossEntropy {
            return Err(JsValue::from_str(
                "train_batch is binary-only; use train_batch_multi_class for multi-class",
            ));
        }
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

    /// Trains one batch using `CrossEntropyWithLogits`.
    ///
    /// `inputs` is `batch_size * input_dim` floats row-major.
    /// `class_indices` is `batch_size` class labels in `0..output_dim`.
    /// Each label is one-hot encoded internally to a `[1, output_dim]`
    /// target tensor — this is what the underlying loss function
    /// expects.
    ///
    /// Returns the mean loss across the batch.
    ///
    /// Errors if any class index is out of range, or if this trainer
    /// is binary-mode (use [`train_batch`] instead).
    #[wasm_bindgen(js_name = trainBatchMultiClass)]
    pub fn train_batch_multi_class(
        &self,
        inputs: Vec<f32>,
        class_indices: Vec<u32>,
        lr: f32,
    ) -> Result<f32, JsValue> {
        if self.loss_kind != LossKind::CategoricalCrossEntropy {
            return Err(JsValue::from_str(
                "train_batch_multi_class requires a multi-class trainer (output_dim > 1)",
            ));
        }
        let batch_size = class_indices.len();
        if batch_size == 0 {
            return Ok(0.0);
        }
        if inputs.len() != batch_size * self.input_dim {
            return Err(JsValue::from_str(&format!(
                "train_batch_multi_class: inputs length {} != batch_size {} * input_dim {}",
                inputs.len(),
                batch_size,
                self.input_dim
            )));
        }
        for (i, &c) in class_indices.iter().enumerate() {
            if (c as usize) >= self.output_dim {
                return Err(JsValue::from_str(&format!(
                    "train_batch_multi_class: class_indices[{}] = {} is out of range [0, {})",
                    i, c, self.output_dim
                )));
            }
        }

        let mut graph = self.graph.borrow_mut();
        let target = NodeId(self.output_node);
        let order = graph.topological_sort(target).map_err(js_err)?;
        graph.clear_gradients();

        let mut total_loss = 0.0_f32;
        let loss_fn = gran_prix::loss::CrossEntropyWithLogits;

        for i in 0..batch_size {
            // Inject input row i into the graph's input node.
            {
                let mut input_buffer = self.input_tensor.borrow_mut();
                let slice = input_buffer.as_slice_mut().map_err(js_err)?;
                let start = i * self.input_dim;
                for d in 0..self.input_dim {
                    slice[d] = inputs[start + d];
                }
                if let Some(gran_prix::graph::Node::Input(ref mut t)) =
                    graph.nodes_mut().get_mut(self.input_node)
                {
                    t.copy_from(&input_buffer).map_err(js_err)?;
                }
            }

            // Build one-hot target [1, output_dim] for this sample.
            let mut one_hot = vec![0.0_f32; self.output_dim];
            one_hot[class_indices[i] as usize] = 1.0;
            let target_tensor =
                Tensor::from_shape_vec(&[1, self.output_dim], one_hot).map_err(js_err)?;

            let result = graph.execute_with_order(&order, target).map_err(js_err)?;
            let mut grad = loss_fn.gradient(&result, &target_tensor).map_err(js_err)?;
            // Scale by 1/batch_size so the accumulated gradient is the
            // mean-batch gradient (matches `train_batch`'s convention).
            grad.map_inplace(|v| *v /= batch_size as f32).map_err(js_err)?;

            total_loss += loss_fn.calculate(&result, &target_tensor).map_err(js_err)?;
            graph.backward(target, grad).map_err(js_err)?;
        }

        use gran_prix::optim::Optimizer;
        let mut opt = self.optimizer.borrow_mut();
        opt.lr = lr;
        opt.step_graph(&mut graph).map_err(js_err)?;

        Ok(total_loss / batch_size as f32)
    }

    // ── Architecture introspection ─────────────────────────────────────────

    /// Returns the canonical [`NetworkDef`] JSON used to construct this
    /// trainer.
    ///
    /// The pair `(networkDefJson(), getWeights())` is the canonical
    /// serialization contract for distributing a trained model:
    /// reconstruct via [`from_network_def`] + [`import_weights`] and
    /// the predictions are bit-identical (pinned by
    /// `tests/persistence_e2e.rs`). The full `Graph` serde path also
    /// works for trained MLPs (pinned by
    /// `serde_json_to_string_round_trips_a_trained_graph`), but uses a
    /// less explicit contract — prefer the JSON+weights pair for
    /// anything crossing a trust boundary (disk, network, browser
    /// storage).
    #[wasm_bindgen(js_name = networkDefJson)]
    pub fn network_def_json(&self) -> String {
        self.net_json.clone()
    }

    /// Returns the input feature dimensionality.
    #[wasm_bindgen(js_name = inputDim)]
    pub fn input_dim(&self) -> usize {
        self.input_dim
    }

    /// Returns the output dimensionality (number of classes for
    /// multi-class, 1 for binary).
    #[wasm_bindgen(js_name = outputDim)]
    pub fn output_dim(&self) -> usize {
        self.output_dim
    }

    /// Returns the loss/output mode for this trainer. See [`LossKind`]
    /// for the auto-detection rule.
    #[wasm_bindgen(js_name = lossKind)]
    pub fn loss_kind(&self) -> LossKind {
        self.loss_kind
    }

    // ── Parameter freezing (transfer-learning support) ─────────────────────

    /// Freezes every trainable parameter whose registered name starts
    /// with `prefix`, returning the indices of the parameters that
    /// were affected (in registration order).
    ///
    /// `NetworkDef::compile` registers parameters with names like
    /// `"layers[3].weight"`, so a prefix of `"layers[3]"` freezes the
    /// fourth layer atomically. Layers indexed by activation-only
    /// `LayerDef`s contribute no parameters; their indices appear as
    /// gaps in the namespace.
    ///
    /// An empty return vector means no parameter matched — common if
    /// the caller passed a typo. The method does not error in that
    /// case because the absence of a match isn't necessarily a bug.
    /// Returning the affected indices lets callers audit "did I
    /// freeze the right parameters?" — for instance by passing the
    /// vector to [`param_name`] for a logging readback.
    #[wasm_bindgen(js_name = freezeByPrefix)]
    pub fn freeze_by_prefix(&self, prefix: &str) -> Vec<usize> {
        self.graph
            .borrow_mut()
            .params_mut()
            .freeze_by_name_prefix(prefix)
            .into_iter()
            .map(|p| p.0)
            .collect()
    }

    /// Inverse of [`freezeByPrefix`].
    #[wasm_bindgen(js_name = unfreezeByPrefix)]
    pub fn unfreeze_by_prefix(&self, prefix: &str) -> Vec<usize> {
        self.graph
            .borrow_mut()
            .params_mut()
            .unfreeze_by_name_prefix(prefix)
            .into_iter()
            .map(|p| p.0)
            .collect()
    }

    /// Returns the total number of registered parameters. Use with
    /// [`param_name`] / [`is_frozen_by_index`] to enumerate without
    /// pulling the full name list across the JS↔WASM boundary.
    #[wasm_bindgen(js_name = paramCount)]
    pub fn param_count(&self) -> usize {
        self.graph.borrow().params().len()
    }

    /// Returns the registered name of the parameter at `index`.
    ///
    /// Returns the empty string for out-of-range indices rather than
    /// erroring — this matches the convention `wasm-bindgen` uses
    /// for getters, where a `null`/empty value is more ergonomic than
    /// a thrown exception. Callers that need bound-checked access can
    /// gate on [`param_count`].
    #[wasm_bindgen(js_name = paramName)]
    pub fn param_name(&self, index: usize) -> String {
        let g = self.graph.borrow();
        let names = g.params().names();
        names.get(index).map(|s| s.to_string()).unwrap_or_default()
    }

    /// Returns the registered names of all parameters as a
    /// `string[]`. **Allocates and clones each name on every call.**
    /// For hot paths, prefer [`param_count`] + [`param_name`] or
    /// cache the result on the JS side.
    #[wasm_bindgen(js_name = paramNames)]
    pub fn param_names(&self) -> Vec<String> {
        self.graph
            .borrow()
            .params()
            .names()
            .into_iter()
            .map(String::from)
            .collect()
    }

    /// Returns whether the parameter at `index` is currently frozen.
    /// Out-of-range indices return `false` (consistent with
    /// [`param_name`]'s out-of-range behavior).
    #[wasm_bindgen(js_name = isFrozenByIndex)]
    pub fn is_frozen_by_index(&self, index: usize) -> bool {
        let g = self.graph.borrow();
        if index >= g.params().len() {
            return false;
        }
        g.params().is_frozen(gran_prix::ParamId(index))
    }

    // ── Inference ──────────────────────────────────────────────────────────

    /// Batched inference over a flat input buffer.
    ///
    /// `inputs` must be `batch_size * input_dim` floats laid out
    /// row-major (i.e., sample `i`'s features start at index
    /// `i * input_dim`). The output is `batch_size` probabilities,
    /// each sigmoid-mapped from the network's logit output for the
    /// corresponding sample — one per row of the input.
    ///
    /// # Performance
    ///
    /// This is a **single forward pass** with batch dimension `B`,
    /// not `B` independent forwards. The cost of `predict_batch(B)`
    /// is approximately the cost of one matmul over `[B, in] x [in, out]`
    /// instead of `B` matmuls over `[1, in] x [in, out]`. For DOM
    /// classification with thousands of nodes, this is the difference
    /// between an `O(B)` JS↔WASM boundary cost and a single boundary
    /// crossing.
    ///
    /// # Equivalence with `predict`
    ///
    /// For an MLP without `BatchNorm`, `predict_batch` is bit-equivalent
    /// to calling `predict` once per row. Networks containing
    /// `BatchNorm` are *not* bit-equivalent because BN computes batch
    /// statistics from the input batch — single-sample BN falls back
    /// to affine, batched BN uses the row-wise statistics. This
    /// matches the documented design of `BatchNorm` in
    /// `src/layers/batchnorm.rs`.
    ///
    /// # Externally observable state
    ///
    /// None. The input node's tensor is snapshotted at entry,
    /// transiently widened to `[batch_size, input_dim]` for the
    /// forward pass, then restored to its exact original value at
    /// exit (success or error). Concurrent observers of the input
    /// node would see the temporary state — but `Trainer` is not
    /// `Send` / `Sync` and is meant for single-threaded use, so
    /// there's no real observer.
    ///
    /// # Output assumption
    ///
    /// Binary-classification path (sigmoid). For multi-class trainers
    /// this method returns an error — use [`predict_probs_batch`]
    /// instead.
    #[wasm_bindgen(js_name = predictBatch)]
    pub fn predict_batch(
        &self,
        inputs: Vec<f32>,
        batch_size: usize,
    ) -> Result<Vec<f32>, JsValue> {
        if self.loss_kind != LossKind::BinaryCrossEntropy {
            return Err(JsValue::from_str(
                "predict_batch is binary-only; use predict_probs_batch for multi-class",
            ));
        }
        if batch_size == 0 {
            return Ok(Vec::new());
        }
        let expected_len = batch_size.checked_mul(self.input_dim).ok_or_else(|| {
            JsValue::from_str(&format!(
                "predict_batch: batch_size={} * input_dim={} overflows usize",
                batch_size, self.input_dim
            ))
        })?;
        if inputs.len() != expected_len {
            return Err(JsValue::from_str(&format!(
                "predict_batch: inputs length {} != batch_size {} * input_dim {}",
                inputs.len(),
                batch_size,
                self.input_dim
            )));
        }
        for (i, v) in inputs.iter().enumerate() {
            if !v.is_finite() {
                return Err(JsValue::from_str(&format!(
                    "predict_batch: input[{}] is non-finite ({})",
                    i, v
                )));
            }
        }

        let mut graph = self.graph.borrow_mut();
        let logits = batched_forward_logits(
            &mut graph,
            self.input_node,
            NodeId(self.output_node),
            self.input_dim,
            batch_size,
            inputs,
        )?;

        // Sigmoid element-wise. For the binary head, output_dim = 1,
        // so logits.len() == batch_size. For multi-output networks
        // we still apply sigmoid element-wise — that's the
        // `LossKind::BinaryCrossEntropy` semantic of independent
        // sigmoid heads.
        let mut probs = Vec::with_capacity(logits.len());
        for &logit in &logits {
            probs.push(1.0 / (1.0 + (-logit).exp()));
        }
        Ok(probs)
    }

    /// Runs a single forward pass and returns a sigmoid-mapped probability.
    ///
    /// **Output assumption.** This trainer is wired for binary
    /// classification: training uses [`BCEWithLogits`], `predict` reads
    /// `slice[0]` of the network's output and applies sigmoid. If the
    /// underlying [`NetworkDef`] declares `output_dim > 1`, this method
    /// silently ignores all but the first output element. Multi-class
    /// classification needs a different inference path (softmax), which
    /// is documented as a deferred capability in `KNOWN-GAPS.md`.
    pub fn predict(&self, features: Vec<f32>) -> Result<f32, JsValue> {
        if self.loss_kind != LossKind::BinaryCrossEntropy {
            return Err(JsValue::from_str(
                "predict is binary-only; use predict_probs or predict_class for multi-class",
            ));
        }
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

    /// Returns the full output distribution for a single sample.
    ///
    /// Output shape:
    ///  - Binary trainer (`output_dim == 1`): a 1-element vector
    ///    containing the sigmoid of the logit, i.e. `P(class=1)`.
    ///  - Multi-class trainer: an `output_dim`-element vector of
    ///    softmax probabilities summing to 1.
    ///
    /// Works for both modes — callers that don't care about the
    /// distinction can use this uniformly. Use [`predict_class`] if
    /// only the argmax is needed.
    #[wasm_bindgen(js_name = predictProbs)]
    pub fn predict_probs(&self, features: Vec<f32>) -> Result<Vec<f32>, JsValue> {
        if features.len() != self.input_dim {
            return Err(JsValue::from_str(&format!(
                "predict_probs: features length {} != input_dim {}",
                features.len(),
                self.input_dim
            )));
        }
        for (i, v) in features.iter().enumerate() {
            if !v.is_finite() {
                return Err(JsValue::from_str(&format!(
                    "predict_probs: features[{}] is non-finite ({})",
                    i, v
                )));
            }
        }

        let mut graph = self.graph.borrow_mut();
        {
            let mut input_buffer = self.input_tensor.borrow_mut();
            let slice = input_buffer.as_slice_mut().map_err(js_err)?;
            for d in 0..self.input_dim {
                slice[d] = features[d];
            }
            if let Some(gran_prix::graph::Node::Input(ref mut t)) =
                graph.nodes_mut().get_mut(self.input_node)
            {
                t.copy_from(&input_buffer).map_err(js_err)?;
            }
        }

        let result = graph.execute(NodeId(self.output_node)).map_err(js_err)?;
        let logits = result.as_slice().map_err(js_err)?;
        Ok(apply_output_activation(logits, self.output_dim, self.loss_kind))
    }

    /// Returns the predicted class index (argmax of [`predict_probs`]).
    ///
    /// For a binary trainer this is `1` if `P(class=1) >= 0.5`,
    /// otherwise `0` — the natural default. For a multi-class trainer
    /// it's `argmax_i softmax(logits)[i]`, breaking ties in favor of
    /// the lowest index (`>` rather than `>=` in the scan).
    ///
    /// Use [`predict_class_with_threshold`] to override the binary
    /// decision threshold; production deployments often tune it via
    /// precision/recall trade-off rather than fixing it at 0.5.
    #[wasm_bindgen(js_name = predictClass)]
    pub fn predict_class(&self, features: Vec<f32>) -> Result<usize, JsValue> {
        self.predict_class_with_threshold(features, 0.5)
    }

    /// Like [`predict_class`] but with a caller-supplied decision
    /// threshold for the binary case.
    ///
    /// `threshold` must be in `[0, 1]`. For multi-class trainers the
    /// threshold is ignored — the choice is always argmax — and a
    /// threshold outside `[0, 1]` is rejected for both modes (catches
    /// caller errors like passing `0.5` as a logit instead of a
    /// probability).
    #[wasm_bindgen(js_name = predictClassWithThreshold)]
    pub fn predict_class_with_threshold(
        &self,
        features: Vec<f32>,
        threshold: f32,
    ) -> Result<usize, JsValue> {
        if !(0.0..=1.0).contains(&threshold) || !threshold.is_finite() {
            return Err(JsValue::from_str(&format!(
                "predict_class_with_threshold: threshold={} is not in [0, 1]",
                threshold
            )));
        }
        let probs = self.predict_probs(features)?;
        match self.loss_kind {
            LossKind::BinaryCrossEntropy => {
                let p = probs.first().copied().unwrap_or(0.0);
                Ok(if p >= threshold { 1 } else { 0 })
            }
            LossKind::CategoricalCrossEntropy => {
                // `threshold` is unused for argmax; the validation
                // above still runs as a defense against callers
                // passing nonsense values.
                let mut best = 0usize;
                let mut best_p = f32::NEG_INFINITY;
                for (i, &p) in probs.iter().enumerate() {
                    if p > best_p {
                        best_p = p;
                        best = i;
                    }
                }
                Ok(best)
            }
        }
    }

    /// Batched version of [`predict_probs`].
    ///
    /// Output is row-major flat: `output[i * output_dim + c]` is the
    /// probability of class `c` for sample `i`. Length is
    /// `batch_size * output_dim`.
    ///
    /// Same single-forward batched semantics as [`predict_batch`].
    /// Side effect: input node is widened then reset to
    /// `[1, input_dim]` zeros at exit.
    #[wasm_bindgen(js_name = predictProbsBatch)]
    pub fn predict_probs_batch(
        &self,
        inputs: Vec<f32>,
        batch_size: usize,
    ) -> Result<Vec<f32>, JsValue> {
        if batch_size == 0 {
            return Ok(Vec::new());
        }
        let expected_len = batch_size.checked_mul(self.input_dim).ok_or_else(|| {
            JsValue::from_str(&format!(
                "predict_probs_batch: batch_size={} * input_dim={} overflows usize",
                batch_size, self.input_dim
            ))
        })?;
        if inputs.len() != expected_len {
            return Err(JsValue::from_str(&format!(
                "predict_probs_batch: inputs length {} != batch_size {} * input_dim {}",
                inputs.len(),
                batch_size,
                self.input_dim
            )));
        }
        for (i, v) in inputs.iter().enumerate() {
            if !v.is_finite() {
                return Err(JsValue::from_str(&format!(
                    "predict_probs_batch: input[{}] is non-finite ({})",
                    i, v
                )));
            }
        }

        let mut graph = self.graph.borrow_mut();
        let logits = batched_forward_logits(
            &mut graph,
            self.input_node,
            NodeId(self.output_node),
            self.input_dim,
            batch_size,
            inputs,
        )?;
        Ok(apply_output_activation(&logits, self.output_dim, self.loss_kind))
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


// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod loss_compat_tests {
    use super::*;
    use gran_prix::network_def::LayerDef;

    #[test]
    fn validate_loss_compat_rejects_terminal_sigmoid_with_bce() {
        let net = NetworkDef::new(2, vec![
            LayerDef::Linear { in_features: 2, out_features: 1 },
            LayerDef::Activation { function: ActivationType::Sigmoid },
        ]);
        let err = validate_loss_compat(&net, LossKind::BinaryCrossEntropy).unwrap_err();
        assert!(err.contains("Sigmoid"), "expected Sigmoid diagnostic, got: {err}");
    }

    #[test]
    fn validate_loss_compat_rejects_terminal_softmax_with_cce() {
        let net = NetworkDef::new(2, vec![
            LayerDef::Linear { in_features: 2, out_features: 3 },
            LayerDef::Activation { function: ActivationType::Softmax },
        ]);
        let err = validate_loss_compat(&net, LossKind::CategoricalCrossEntropy).unwrap_err();
        assert!(err.contains("Softmax"), "expected Softmax diagnostic, got: {err}");
    }

    #[test]
    fn validate_loss_compat_accepts_compatible_architectures() {
        let net1 = NetworkDef::new(2, vec![
            LayerDef::Linear { in_features: 2, out_features: 1 },
        ]);
        assert!(validate_loss_compat(&net1, LossKind::BinaryCrossEntropy).is_ok());

        let net2 = NetworkDef::new(2, vec![
            LayerDef::Linear { in_features: 2, out_features: 3 },
        ]);
        assert!(validate_loss_compat(&net2, LossKind::CategoricalCrossEntropy).is_ok());

        let net3 = NetworkDef::new(2, vec![
            LayerDef::Linear { in_features: 2, out_features: 4 },
            LayerDef::Activation { function: ActivationType::Sigmoid },
            LayerDef::Linear { in_features: 4, out_features: 1 },
        ]);
        assert!(validate_loss_compat(&net3, LossKind::BinaryCrossEntropy).is_ok());
    }
}
