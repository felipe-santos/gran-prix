//! Inference: `predict*` (binary and multi-class) and the decision boundary.

use super::forward::{apply_output_activation, batched_forward_logits};
use super::{js_err, LossKind, Trainer};
use gran_prix::NodeId;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl Trainer {
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
        graph.set_training(false); // predictions never run in training mode
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
        graph.set_training(false); // predictions never run in training mode
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
        graph.set_training(false); // predictions never run in training mode
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
        graph.set_training(false); // predictions never run in training mode
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
        graph.set_training(false); // predictions never run in training mode
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
