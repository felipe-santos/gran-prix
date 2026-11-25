//! Training: the per-sample batch loops and `train_batch` /
//! `train_step` / `trainBatchMultiClass`.

use super::{js_err, LossKind, Trainer};
use gran_prix::graph::Graph;
use gran_prix::loss::Loss;
use gran_prix::{GPError, NodeId, Tensor};
use wasm_bindgen::prelude::*;

/// Runs `f` with the graph in training mode (Dropout active) and always
/// restores eval mode afterwards, on the success and the error path.
///
/// Generic over the error type so the training loops can return a typed
/// `GPError` (testable natively; `JsValue` panics off wasm32) and be mapped
/// to `JsValue` only at the `#[wasm_bindgen]` boundary.
///
/// The `Trainer` is in eval mode at rest: every `predict*` path relies on
/// that, and additionally forces eval mode itself before running.
pub(super) fn with_training_mode<T, E>(
    graph: &mut Graph,
    f: impl FnOnce(&mut Graph) -> Result<T, E>,
) -> Result<T, E> {
    graph.set_training(true);
    let result = f(graph);
    graph.set_training(false);
    result
}

impl Trainer {
    /// Per-sample forward + backward over a binary batch, accumulating the
    /// parameter gradients (the caller clears them, sets training mode and
    /// steps the optimizer). Returns the summed loss. Typed `GPError` so the
    /// error path is testable natively.
    pub(super) fn binary_batch_loop(
        &self,
        graph: &mut Graph,
        order: &[NodeId],
        inputs: &[f32],
        targets: &[f32],
    ) -> Result<f32, GPError> {
        let batch_size = targets.len();
        let target = NodeId(self.output_node);
        let loss_fn = gran_prix::loss::BCEWithLogits;
        let mut total_loss = 0.0;
        for i in 0..batch_size {
            {
                let mut input_buffer = self.input_tensor.borrow_mut();
                if let Ok(slice) = input_buffer.as_slice_mut() {
                    let start = i * self.input_dim;
                    for d in 0..self.input_dim {
                        slice[d] = inputs[start + d];
                    }
                }
                if let Some(gran_prix::graph::Node::Input(ref mut t)) = graph.nodes_mut().get_mut(self.input_node) {
                    t.copy_from(&input_buffer)?;
                }
            }

            let result = graph.execute_with_order(order, target)?;
            let target_tensor = Tensor::from_shape_vec(&[1, 1], vec![targets[i]])?;

            let mut grad = loss_fn.gradient(&result, &target_tensor)?;
            grad.map_inplace(|v| *v /= batch_size as f32)?;

            total_loss += loss_fn.calculate(&result, &target_tensor)?;
            graph.backward(target, grad)?;
        }
        Ok(total_loss)
    }

    /// Multi-class counterpart of [`Self::binary_batch_loop`]
    /// (`CrossEntropyWithLogits`, one-hot targets from `class_indices`).
    pub(super) fn multi_class_batch_loop(
        &self,
        graph: &mut Graph,
        order: &[NodeId],
        inputs: &[f32],
        class_indices: &[u32],
    ) -> Result<f32, GPError> {
        let batch_size = class_indices.len();
        let target = NodeId(self.output_node);
        let loss_fn = gran_prix::loss::CrossEntropyWithLogits;
        let mut total_loss = 0.0_f32;
        for i in 0..batch_size {
            // Inject input row i into the graph's input node.
            {
                let mut input_buffer = self.input_tensor.borrow_mut();
                let slice = input_buffer.as_slice_mut()?;
                let start = i * self.input_dim;
                for d in 0..self.input_dim {
                    slice[d] = inputs[start + d];
                }
                if let Some(gran_prix::graph::Node::Input(ref mut t)) =
                    graph.nodes_mut().get_mut(self.input_node)
                {
                    t.copy_from(&input_buffer)?;
                }
            }

            // Build one-hot target [1, output_dim] for this sample.
            let mut one_hot = vec![0.0_f32; self.output_dim];
            one_hot[class_indices[i] as usize] = 1.0;
            let target_tensor = Tensor::from_shape_vec(&[1, self.output_dim], one_hot)?;

            let result = graph.execute_with_order(order, target)?;
            let mut grad = loss_fn.gradient(&result, &target_tensor)?;
            // Scale by 1/batch_size so the accumulated gradient is the
            // mean-batch gradient (matches `train_batch`'s convention).
            grad.map_inplace(|v| *v /= batch_size as f32)?;

            total_loss += loss_fn.calculate(&result, &target_tensor)?;
            graph.backward(target, grad)?;
        }
        Ok(total_loss)
    }
}

#[wasm_bindgen]
impl Trainer {
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

        let target = NodeId(self.output_node);
        let order = graph.topological_sort(target).map_err(js_err)?;

        // One clear per batch: per-sample forward+backward accumulates the
        // parameter gradients in the ParamStore (node gradients are per call).
        graph.clear_gradients();

        // Training mode so Dropout is active; eval mode is restored on exit.
        let total_loss = with_training_mode(&mut graph, |graph| {
            self.binary_batch_loop(graph, &order, &inputs, &targets)
        })
        .map_err(js_err)?;

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
        // One clear per batch: per-sample forward+backward accumulates the
        // parameter gradients in the ParamStore (node gradients are per call).
        graph.clear_gradients();

        // Training mode so Dropout is active; eval mode is restored on exit.
        let total_loss = with_training_mode(&mut graph, |graph| {
            self.multi_class_batch_loop(graph, &order, &inputs, &class_indices)
        })
        .map_err(js_err)?;

        use gran_prix::optim::Optimizer;
        let mut opt = self.optimizer.borrow_mut();
        opt.lr = lr;
        opt.step_graph(&mut graph).map_err(js_err)?;

        Ok(total_loss / batch_size as f32)
    }
}
