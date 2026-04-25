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
    /// Auto-detection rule used by every [`Trainer`] constructor.
    /// Centralized here so the rule has one definition and one test
    /// surface.
    fn from_output_dim(output_dim: usize) -> Self {
        if output_dim == 1 {
            LossKind::BinaryCrossEntropy
        } else {
            LossKind::CategoricalCrossEntropy
        }
    }
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
        // Snapshot the canonical JSON before compile consumes the def.
        let net_json = net.to_json().map_err(js_err)?;
        let output_dim = net.output_dim();
        let loss_kind = LossKind::from_output_dim(output_dim);
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
            loss_kind,
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
        let loss_kind = LossKind::from_output_dim(output_dim);
        // Re-serialize from the parsed `NetworkDef` so the stored JSON
        // is canonical (whitespace-normalized) and provably round-trip
        // identical, regardless of how the caller-supplied input was
        // formatted.
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

    /// Backward-compatible: parses the old `WasmArchitecture` JSON format
    /// by converting it to a [`NetworkDef`] internally.
    ///
    /// Supported layer types: Input, Linear, Activation (relu/sigmoid/tanh),
    /// Rnn, Gru, Output, Dropout (passthrough), Batchnorm (passthrough).
    #[wasm_bindgen(js_name = fromArchitecture)]
    pub fn from_architecture(json: &str) -> Result<Trainer, JsValue> {
        let net_def = convert_legacy_architecture(json).map_err(|e| JsValue::from_str(&e))?;
        let input_dim = net_def.input_dim;
        let output_dim = net_def.output_dim();
        let loss_kind = LossKind::from_output_dim(output_dim);
        // The legacy WasmArchitecture format isn't round-trip-safe;
        // store the canonical NetworkDef JSON instead so any later
        // `network_def_json()` reader gets a reliable artifact.
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
    /// with `prefix`, returning the count affected.
    ///
    /// `NetworkDef::compile` registers parameters with names like
    /// `"layers[3].weight"`, so a prefix of `"layers[3]"` freezes the
    /// fourth layer atomically. Layers indexed by activation-only
    /// `LayerDef`s contribute no parameters; their indices appear as
    /// gaps in the namespace.
    ///
    /// A return of `0` means no parameter matched — common if the
    /// caller passed a typo. The method does not error in that case
    /// because the absence of a match isn't necessarily a bug
    /// (e.g., a `paranoidFreeze` caller might attempt several
    /// candidate prefixes).
    #[wasm_bindgen(js_name = freezeByPrefix)]
    pub fn freeze_by_prefix(&self, prefix: &str) -> usize {
        self.graph.borrow_mut().params_mut().freeze_by_name_prefix(prefix)
    }

    /// Inverse of [`freezeByPrefix`].
    #[wasm_bindgen(js_name = unfreezeByPrefix)]
    pub fn unfreeze_by_prefix(&self, prefix: &str) -> usize {
        self.graph.borrow_mut().params_mut().unfreeze_by_name_prefix(prefix)
    }

    /// Returns the registered names of all parameters in registration
    /// order. Useful for callers that need to enumerate available
    /// freeze targets — for example, a "freeze backbone, leave head
    /// trainable" UI that lists every layer prefix.
    ///
    /// JS sees a `string[]` because `wasm-bindgen` auto-converts
    /// `Vec<String>`.
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
    /// # Side effects
    ///
    /// At entry, the input node's tensor shape is widened from
    /// `[1, input_dim]` to `[batch_size, input_dim]`. At exit, it's
    /// reset back to `[1, input_dim]` (zero-filled) so subsequent
    /// `predict` / `train_batch` calls — which `copy_from` a
    /// `[1, input_dim]` buffer and would error on a shape mismatch
    /// — work without surprise.
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

        // Widen the input node to `[batch_size, input_dim]` for one
        // batched forward.
        let batch_tensor =
            Tensor::from_shape_vec(&[batch_size, self.input_dim], inputs).map_err(js_err)?;
        match graph.nodes_mut().get_mut(self.input_node) {
            Some(gran_prix::graph::Node::Input(t)) => *t = batch_tensor,
            _ => return Err(JsValue::from_str("predict_batch: input node not Input")),
        }
        // Invalidate any cached intermediate values from prior forwards.
        graph.clear_values();

        let result = graph
            .execute(NodeId(self.output_node))
            .map_err(js_err)?;
        let logits = result.as_slice().map_err(js_err)?;

        // Sigmoid element-wise. The output is `[batch_size, output_dim]`
        // (output_dim = 1 for binary), so `logits.len() == batch_size`
        // for the binary classifier path. We don't assert that — a
        // multi-output network would emit `batch_size * output_dim`
        // floats and the consumer would interpret them themselves.
        let mut probs = Vec::with_capacity(logits.len());
        for &logit in logits {
            probs.push(1.0 / (1.0 + (-logit).exp()));
        }

        // Reset the input node to `[1, input_dim]` zeros so subsequent
        // `predict` / `train_batch` calls — which copy_from a
        // `[1, input_dim]` buffer — don't see a shape mismatch.
        if let Some(gran_prix::graph::Node::Input(t)) =
            graph.nodes_mut().get_mut(self.input_node)
        {
            *t = Tensor::new_zeros(&[1, self.input_dim]);
        }
        graph.clear_values();

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
    /// For a binary trainer the result is `1` if `P(class=1) >= 0.5`
    /// and `0` otherwise — matches the convention `predict() >= 0.5`.
    /// For a multi-class trainer it's `argmax_i softmax(logits)[i]`,
    /// breaking ties in favor of the lower index (the natural behavior
    /// of a left-to-right scan).
    #[wasm_bindgen(js_name = predictClass)]
    pub fn predict_class(&self, features: Vec<f32>) -> Result<usize, JsValue> {
        let probs = self.predict_probs(features)?;
        match self.loss_kind {
            LossKind::BinaryCrossEntropy => {
                let p = probs.first().copied().unwrap_or(0.0);
                Ok(if p >= 0.5 { 1 } else { 0 })
            }
            LossKind::CategoricalCrossEntropy => {
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
        let batch_tensor =
            Tensor::from_shape_vec(&[batch_size, self.input_dim], inputs).map_err(js_err)?;
        match graph.nodes_mut().get_mut(self.input_node) {
            Some(gran_prix::graph::Node::Input(t)) => *t = batch_tensor,
            _ => {
                return Err(JsValue::from_str(
                    "predict_probs_batch: input node not Input",
                ));
            }
        }
        graph.clear_values();

        let result = graph
            .execute(NodeId(self.output_node))
            .map_err(js_err)?;
        let logits = result.as_slice().map_err(js_err)?;
        let probs = apply_output_activation(logits, self.output_dim, self.loss_kind);

        // Reset input node — see `predict_batch` for the rationale.
        if let Some(gran_prix::graph::Node::Input(t)) =
            graph.nodes_mut().get_mut(self.input_node)
        {
            *t = Tensor::new_zeros(&[1, self.input_dim]);
        }
        graph.clear_values();

        Ok(probs)
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
    /// Dropout rate in [0, 1]. Optional in the legacy format; if omitted
    /// we default to 0.0 (no-op) rather than the common ML default of 0.5,
    /// because silently dropping half of a model's activations when the
    /// caller said nothing would change inference behavior in a way the
    /// caller cannot have intended.
    dropout_rate: Option<f32>,
    /// BatchNorm feature count. Optional; defaults to the current flow
    /// dimension at the layer's position in the BFS.
    num_features: Option<usize>,
}

#[derive(Deserialize)]
struct LegacyConnection {
    from: String,
    to: String,
}

/// Converts the old `WasmArchitecture` JSON to a `NetworkDef`.
///
/// Walks connections from the input layer in BFS order. `input` and
/// `output` layers are markers in the legacy graph format and produce no
/// computation node. `dropout` and `batchnorm` *do* produce computation
/// nodes and are mapped to the corresponding [`LayerDef`].
///
/// The error type is `String` (not `JsValue`) so the function can be
/// unit-tested in a native target without a WASM runtime. The WASM
/// caller wraps the result with `JsValue::from_str` at the boundary.
fn convert_legacy_architecture(json: &str) -> Result<NetworkDef, String> {
    let arch: LegacyArchitecture = serde_json::from_str(json)
        .map_err(|e| format!("Failed to parse architecture: {}", e))?;

    // Find input layer
    let input_layer = arch.layers.iter()
        .find(|l| l.layer_type == "input")
        .ok_or_else(|| "No input layer found".to_string())?;

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
            .ok_or_else(|| format!("Layer {} not found", layer_id))?;

        match layer.layer_type.as_str() {
            "linear" => {
                let in_f = layer.params.input_size.unwrap_or(current_dim);
                let out_f = layer.params.output_size
                    .ok_or_else(|| "Linear layer missing outputSize".to_string())?;
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
                    _ => return Err(format!("Unknown activation: {}", act_str)),
                };
                layer_defs.push(LayerDef::Activation { function });
            }
            "rnn" => {
                let in_s = layer.params.input_size.unwrap_or(current_dim);
                let h_s = layer.params.hidden_size
                    .ok_or_else(|| "RNN layer missing hiddenSize".to_string())?;
                layer_defs.push(LayerDef::Rnn { input_size: in_s, hidden_size: h_s });
                current_dim = h_s;
            }
            "gru" => {
                let in_s = layer.params.input_size.unwrap_or(current_dim);
                let h_s = layer.params.hidden_size
                    .ok_or_else(|| "GRU layer missing hiddenSize".to_string())?;
                layer_defs.push(LayerDef::Gru { input_size: in_s, hidden_size: h_s });
                current_dim = h_s;
            }
            "dropout" => {
                let rate = layer.params.dropout_rate.unwrap_or(0.0);
                if !(0.0..=1.0).contains(&rate) {
                    return Err(format!("Dropout rate {} out of range [0, 1]", rate));
                }
                layer_defs.push(LayerDef::Dropout { rate });
                // Dropout is identity in shape; current_dim unchanged.
            }
            "batchnorm" => {
                let nf = layer.params.num_features.unwrap_or(current_dim);
                if nf != current_dim {
                    return Err(format!(
                        "BatchNorm numFeatures={} mismatches current flow dim {}",
                        nf, current_dim
                    ));
                }
                layer_defs.push(LayerDef::BatchNorm { num_features: nf });
                // BatchNorm is identity in shape; current_dim unchanged.
            }
            "input" | "output" => {
                // Markers in the legacy graph format, not computation nodes.
            }
            other => {
                return Err(format!("Unknown layer type: {}", other));
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
        return Err("Architecture produced no layers".to_string());
    }

    Ok(NetworkDef::new(arch.input_dim, layer_defs))
}

// ── Tests ─────────────────────────────────────────────────────────────────
//
// `convert_legacy_architecture` returns `Result<_, String>` so tests can
// run in the native target (`cargo test`). The WASM-only `Trainer` API
// is exercised through `wasm-pack test` if/when WASM-side tests are
// reintroduced.

#[cfg(test)]
mod legacy_converter_tests {
    use super::*;
    use gran_prix::network_def::LayerDef;

    /// Minimal happy path: input → linear → output. Mirrors the JSON
    /// shape produced by `demo-web/src/components/playground/v2/
    /// NetworkBuilder/NetworkSerializer.ts::serializeForTrainer`.
    #[test]
    fn converts_minimal_input_linear_output() {
        let json = r#"{
            "layers": [
                {"id": "in1", "type": "input", "params": {"inputSize": 2}},
                {"id": "lin1", "type": "linear", "params": {"inputSize": 2, "outputSize": 4}},
                {"id": "out1", "type": "output", "params": {"outputSize": 4}}
            ],
            "connections": [
                {"from": "in1", "to": "lin1"},
                {"from": "lin1", "to": "out1"}
            ],
            "inputDim": 2,
            "outputDim": 4
        }"#;
        let net = convert_legacy_architecture(json).expect("converts");
        assert_eq!(net.input_dim, 2);
        assert_eq!(net.layers.len(), 1);
        assert!(matches!(net.layers[0],
            LayerDef::Linear { in_features: 2, out_features: 4 }));
    }

    /// The bug this fix addresses: dropout and batchnorm layers used to
    /// be silently dropped. Now they map to `LayerDef::Dropout` and
    /// `LayerDef::BatchNorm` respectively.
    #[test]
    fn dropout_and_batchnorm_are_no_longer_silently_skipped() {
        let json = r#"{
            "layers": [
                {"id": "in1",  "type": "input",     "params": {"inputSize": 4}},
                {"id": "lin1", "type": "linear",    "params": {"inputSize": 4, "outputSize": 8}},
                {"id": "drop1","type": "dropout",   "params": {"dropoutRate": 0.3}},
                {"id": "bn1",  "type": "batchnorm", "params": {"numFeatures": 8}},
                {"id": "lin2", "type": "linear",    "params": {"inputSize": 8, "outputSize": 1}},
                {"id": "out1", "type": "output",    "params": {"outputSize": 1}}
            ],
            "connections": [
                {"from": "in1",  "to": "lin1"},
                {"from": "lin1", "to": "drop1"},
                {"from": "drop1","to": "bn1"},
                {"from": "bn1",  "to": "lin2"},
                {"from": "lin2", "to": "out1"}
            ],
            "inputDim": 4,
            "outputDim": 1
        }"#;
        let net = convert_legacy_architecture(json).expect("converts");
        assert_eq!(net.layers.len(), 4); // linear, dropout, batchnorm, linear

        match &net.layers[1] {
            LayerDef::Dropout { rate } => assert!((rate - 0.3).abs() < 1e-6),
            other => panic!("expected Dropout, got {other:?}"),
        }
        match &net.layers[2] {
            LayerDef::BatchNorm { num_features } => assert_eq!(*num_features, 8),
            other => panic!("expected BatchNorm, got {other:?}"),
        }
    }

    /// Default `dropoutRate` is 0.0 (no-op), not 0.5. A missing rate
    /// must not silently change inference behavior — the choice of 0.0
    /// over 0.5 is documented in `LegacyParams::dropout_rate`.
    #[test]
    fn dropout_without_rate_defaults_to_zero() {
        let json = r#"{
            "layers": [
                {"id": "in1", "type": "input",   "params": {"inputSize": 2}},
                {"id": "d1",  "type": "dropout", "params": {}},
                {"id": "out", "type": "output",  "params": {"outputSize": 2}}
            ],
            "connections": [
                {"from": "in1", "to": "d1"},
                {"from": "d1",  "to": "out"}
            ],
            "inputDim": 2,
            "outputDim": 2
        }"#;
        let net = convert_legacy_architecture(json).expect("converts");
        match &net.layers[0] {
            LayerDef::Dropout { rate } => assert_eq!(*rate, 0.0),
            other => panic!("expected Dropout, got {other:?}"),
        }
    }

    #[test]
    fn dropout_rejects_out_of_range_rate() {
        let json = r#"{
            "layers": [
                {"id": "in1", "type": "input",   "params": {"inputSize": 2}},
                {"id": "d1",  "type": "dropout", "params": {"dropoutRate": 1.5}},
                {"id": "out", "type": "output",  "params": {"outputSize": 2}}
            ],
            "connections": [
                {"from": "in1", "to": "d1"},
                {"from": "d1",  "to": "out"}
            ],
            "inputDim": 2,
            "outputDim": 2
        }"#;
        let err = convert_legacy_architecture(json).unwrap_err();
        assert!(err.contains("out of range"), "unexpected error: {err}");
    }

    /// BatchNorm `numFeatures` must equal the current flow dimension.
    /// A mismatch is a configuration bug — fail loud rather than
    /// silently produce the wrong model.
    #[test]
    fn batchnorm_with_mismatched_num_features_errors() {
        let json = r#"{
            "layers": [
                {"id": "in1", "type": "input",     "params": {"inputSize": 4}},
                {"id": "bn1", "type": "batchnorm", "params": {"numFeatures": 99}},
                {"id": "out", "type": "output",    "params": {"outputSize": 4}}
            ],
            "connections": [
                {"from": "in1", "to": "bn1"},
                {"from": "bn1", "to": "out"}
            ],
            "inputDim": 4,
            "outputDim": 4
        }"#;
        let err = convert_legacy_architecture(json).unwrap_err();
        assert!(err.contains("mismatches"), "unexpected error: {err}");
    }

    /// Default `numFeatures` is the current flow dim — convenience
    /// for the common case where BatchNorm sits right after a Linear.
    #[test]
    fn batchnorm_inherits_num_features_from_flow() {
        let json = r#"{
            "layers": [
                {"id": "in1", "type": "input",     "params": {"inputSize": 4}},
                {"id": "lin", "type": "linear",    "params": {"outputSize": 8}},
                {"id": "bn1", "type": "batchnorm", "params": {}},
                {"id": "out", "type": "output",    "params": {"outputSize": 8}}
            ],
            "connections": [
                {"from": "in1", "to": "lin"},
                {"from": "lin", "to": "bn1"},
                {"from": "bn1", "to": "out"}
            ],
            "inputDim": 4,
            "outputDim": 8
        }"#;
        let net = convert_legacy_architecture(json).expect("converts");
        match &net.layers[1] {
            LayerDef::BatchNorm { num_features } => assert_eq!(*num_features, 8),
            other => panic!("expected BatchNorm, got {other:?}"),
        }
    }

    #[test]
    fn unknown_layer_type_errors() {
        let json = r#"{
            "layers": [
                {"id": "in1", "type": "input",  "params": {"inputSize": 2}},
                {"id": "x1",  "type": "wat",    "params": {}},
                {"id": "out", "type": "output", "params": {"outputSize": 2}}
            ],
            "connections": [
                {"from": "in1", "to": "x1"},
                {"from": "x1",  "to": "out"}
            ],
            "inputDim": 2,
            "outputDim": 2
        }"#;
        let err = convert_legacy_architecture(json).unwrap_err();
        assert!(err.contains("Unknown layer type"), "got: {err}");
    }

    #[test]
    fn missing_input_layer_errors() {
        let json = r#"{
            "layers": [
                {"id": "lin1", "type": "linear", "params": {"inputSize": 2, "outputSize": 4}}
            ],
            "connections": [],
            "inputDim": 2,
            "outputDim": 4
        }"#;
        let err = convert_legacy_architecture(json).unwrap_err();
        assert!(err.contains("No input"), "got: {err}");
    }

    #[test]
    fn malformed_json_errors() {
        let err = convert_legacy_architecture("{ not valid json").unwrap_err();
        assert!(err.contains("Failed to parse"), "got: {err}");
    }
}
