//! Execution engine — forward pass, backward pass, and value/gradient caching.
//!
//! [`ExecutionEngine`] owns the computation backend and execution state (caches).
//! It operates on an [`Architecture`] (topology) and [`ParamStore`] (parameters)
//! that are passed by reference, enabling the same engine to work with different
//! architectures or parameter configurations.
//!
//! # Separation of Concerns
//!
//! | Component          | Responsibility                              |
//! |--------------------|---------------------------------------------|
//! | `Architecture`     | DAG topology, node management, sort          |
//! | `ParamStore`       | Trainable parameter tensors + gradients      |
//! | `ExecutionEngine`  | Backend, value cache, forward/backward pass  |
//! | `Graph`            | Composes all three into a convenient facade  |

use crate::backend::Backend;
use crate::{GPError, GPResult, Tensor, NodeId};
use crate::params::ParamStore;
use super::{Node, Architecture};

/// Execution engine for computation graphs.
///
/// Owns the computation backend and caches for forward/backward passes.
/// Does not own the graph topology or parameters — those are passed in
/// by reference at execution time.
///
/// # Lifecycle
///
/// 1. Create with a backend: `ExecutionEngine::new(backend)`
/// 2. Call `forward()` with an architecture and param store
/// 3. Call `backward()` to compute gradients
/// 4. Use an optimizer on the param store
/// 5. Repeat from step 2
pub struct ExecutionEngine {
    backend: Box<dyn Backend>,
    /// Cached activation values from the last forward pass.
    values: Vec<Option<Tensor>>,
    /// Per-node gradient accumulator for the backward pass.
    node_gradients: Vec<Option<Tensor>>,
    /// Whether the engine is in training mode (affects Dropout, BatchNorm, etc.).
    training: bool,
    /// RNG seed counter for deterministic dropout masks.
    rng_counter: u64,
}

impl ExecutionEngine {
    /// Creates a new execution engine with the given backend.
    /// Defaults to inference mode (training = false).
    pub fn new(backend: Box<dyn Backend>) -> Self {
        Self {
            backend,
            values: Vec::new(),
            node_gradients: Vec::new(),
            training: false,
            rng_counter: 0,
        }
    }

    /// Returns a reference to the backend.
    pub fn backend(&self) -> &dyn Backend {
        self.backend.as_ref()
    }

    /// Sets training mode. When true, Dropout applies random masking
    /// and BatchNorm uses batch statistics. When false (default), both
    /// are identity/use running stats.
    pub fn set_training(&mut self, training: bool) {
        self.training = training;
    }

    /// Returns whether the engine is in training mode.
    pub fn is_training(&self) -> bool {
        self.training
    }

    /// Returns the cached values from the last forward pass.
    pub fn values(&self) -> &[Option<Tensor>] {
        &self.values
    }

    /// Ensures internal caches are sized to match the architecture.
    fn ensure_cache_size(&mut self, node_count: usize) {
        if self.values.len() < node_count {
            self.values.resize(node_count, None);
        }
        if self.node_gradients.len() < node_count {
            self.node_gradients.resize(node_count, None);
        }
    }

    // ── Parameter Sync ─────────────────────────────────────────────────────

    /// Copies parameter tensors from the [`ParamStore`] into the value cache.
    ///
    /// Must be called before forward execution to ensure the cache reflects
    /// the latest parameter values (e.g., after an optimizer step).
    pub fn sync_params(&mut self, arch: &Architecture, params: &ParamStore) -> GPResult<()> {
        self.ensure_cache_size(arch.node_count());
        for (i, node) in arch.nodes().iter().enumerate() {
            if let Node::Param(param_id) = node {
                let t = params.tensor(*param_id);
                if let Some(Some(cached)) = self.values.get_mut(i) {
                    cached.copy_from(t)?;
                } else {
                    self.values[i] = Some(t.clone());
                }
            }
        }
        Ok(())
    }

    /// Copies per-node gradients for parameter nodes into the [`ParamStore`].
    fn sync_param_gradients(&mut self, arch: &Architecture, params: &mut ParamStore) {
        for (node_idx, node) in arch.nodes().iter().enumerate() {
            if let Node::Param(param_id) = node {
                if let Some(grad) = self.node_gradients[node_idx].take() {
                    params.set_gradient(*param_id, grad);
                }
            }
        }
    }

    // ── Forward Pass ───────────────────────────────────────────────────────

    /// Executes the forward pass for the subgraph rooted at `target`.
    ///
    /// Automatically computes topological order and syncs parameters.
    pub fn forward(
        &mut self,
        arch: &Architecture,
        params: &ParamStore,
        target: NodeId,
    ) -> GPResult<Tensor> {
        let order = arch.topological_sort(target)?;
        self.forward_with_order(arch, params, &order, target)
    }

    /// Executes the forward pass using a pre-computed topological order.
    ///
    /// This is the hot-path for inference: called every frame per agent.
    /// Reuses cached buffers where possible to minimize allocations.
    pub fn forward_with_order(
        &mut self,
        arch: &Architecture,
        params: &ParamStore,
        order: &[NodeId],
        target: NodeId,
    ) -> GPResult<Tensor> {
        self.sync_params(arch, params)?;
        self.ensure_cache_size(arch.node_count());
        let backend = self.backend.as_ref();

        for &node_id in order {
            if node_id.0 >= arch.node_count() || node_id.0 >= self.values.len() {
                return Err(GPError::InferenceError(format!(
                    "Node index {} out of bounds", node_id.0
                )));
            }

            match &arch.nodes()[node_id.0] {
                Node::Input(t) => {
                    if let Some(Some(cached)) = self.values.get_mut(node_id.0) {
                        if cached.shape() == t.shape() {
                            cached.copy_from(t)?;
                        } else {
                            *cached = t.clone();
                        }
                    } else {
                        self.values[node_id.0] = Some(t.clone());
                    }
                }
                Node::Param(_) => {
                    // Already synced via sync_params()
                }
                Node::Op { op, inputs } => {
                    let (left, right) = self.values.split_at_mut(node_id.0);
                    let out_opt = &mut right[0];

                    let mut input_refs = Vec::with_capacity(inputs.len());
                    for &input_id in inputs {
                        if input_id.0 >= node_id.0 || input_id.0 >= left.len() {
                            return Err(GPError::InferenceError(format!(
                                "Input node {:?} is invalid or not before node {:?}",
                                input_id, node_id
                            )));
                        }
                        input_refs.push(left[input_id.0].as_ref().ok_or_else(|| {
                            GPError::InferenceError(format!(
                                "Input value not found for node {:?}", input_id
                            ))
                        })?);
                    }

                    // Advance RNG seed per-node for unique Dropout masks
                    let seed = self.rng_counter;
                    self.rng_counter = self.rng_counter.wrapping_add(1);

                    if let Some(out) = out_opt {
                        op.forward_inplace(&input_refs, out, backend, self.training, seed)?;
                    } else {
                        let val = op.forward(&input_refs, backend, self.training, seed)?;
                        *out_opt = Some(val);
                    }
                }
            };
        }

        self.values[target.0]
            .as_ref()
            .cloned()
            .ok_or_else(|| GPError::InferenceError(format!(
                "Target node {:?} not computed", target
            )))
    }

    /// Executes a single node. Used by the WASM bridge for per-node execution
    /// with corruption checks between calls.
    pub fn execute_single_node(
        &mut self,
        arch: &Architecture,
        params: &ParamStore,
        node_id: NodeId,
    ) -> GPResult<()> {
        self.ensure_cache_size(arch.node_count());
        let backend = self.backend.as_ref();

        match &arch.nodes()[node_id.0] {
            Node::Input(t) => {
                if let Some(Some(cached)) = self.values.get_mut(node_id.0) {
                    if cached.shape() == t.shape() {
                        cached.copy_from(t)?;
                    } else {
                        *cached = t.clone();
                    }
                } else {
                    self.values[node_id.0] = Some(t.clone());
                }
            }
            Node::Param(param_id) => {
                let t = params.tensor(*param_id);
                if self.values[node_id.0].is_none() {
                    self.values[node_id.0] = Some(t.clone());
                }
            }
            Node::Op { op, inputs } => {
                let (left, right) = self.values.split_at_mut(node_id.0);
                let out_opt = &mut right[0];

                let mut input_refs = Vec::with_capacity(inputs.len());
                for &input_id in inputs {
                    input_refs.push(left[input_id.0].as_ref().ok_or_else(|| {
                        GPError::InferenceError(format!(
                            "Value not found for node {:?}", input_id
                        ))
                    })?);
                }

                let seed = self.rng_counter;
                self.rng_counter = self.rng_counter.wrapping_add(1);

                if let Some(out) = out_opt {
                    op.forward_inplace(&input_refs, out, backend, self.training, seed)?;
                } else {
                    let val = op.forward(&input_refs, backend, self.training, seed)?;
                    *out_opt = Some(val);
                }
            }
        };
        Ok(())
    }

    // ── Backward Pass ──────────────────────────────────────────────────────

    /// Computes gradients via reverse-mode automatic differentiation.
    ///
    /// After backward, parameter gradients are automatically forwarded
    /// to the [`ParamStore`].
    pub fn backward(
        &mut self,
        arch: &Architecture,
        params: &mut ParamStore,
        target: NodeId,
        grad_output: Tensor,
    ) -> GPResult<()> {
        let order = arch.topological_sort(target)?;
        self.ensure_cache_size(arch.node_count());
        let backend = self.backend.as_ref();

        // Initialize/Accumulate target gradient
        if let Some(existing) = &self.node_gradients[target.0] {
            self.node_gradients[target.0] = Some(existing + &grad_output);
        } else {
            self.node_gradients[target.0] = Some(grad_output);
        }

        // Process in reverse topological order
        for &node_id in order.iter().rev() {
            let grad = match self.node_gradients[node_id.0].take() {
                Some(g) => g,
                None => continue,
            };

            // Keep the gradient for param gradient forwarding
            self.node_gradients[node_id.0] = Some(grad.clone());

            let (op, inputs) = match &arch.nodes()[node_id.0] {
                Node::Op { op, inputs } => (op, inputs),
                _ => continue, // Leaf nodes don't propagate
            };

            let mut input_refs = Vec::with_capacity(inputs.len());
            for &id in inputs {
                input_refs.push(self.values[id.0].as_ref().ok_or_else(|| {
                    GPError::InferenceError(format!(
                        "Value not found for node {:?}", id
                    ))
                })?);
            }

            // Pass the cached output of this node to backward (needed by Dropout)
            let node_output = self.values[node_id.0].as_ref();
            let input_grads = op.backward(&input_refs, node_output, &grad, backend)?;
            for (i, &input_id) in inputs.iter().enumerate() {
                if let Some(existing) = &self.node_gradients[input_id.0] {
                    self.node_gradients[input_id.0] = Some(existing + &input_grads[i]);
                } else {
                    self.node_gradients[input_id.0] = Some(input_grads[i].clone());
                }
            }
        }

        // Forward parameter gradients to ParamStore
        self.sync_param_gradients(arch, params);

        Ok(())
    }

    // ── Cache Management ───────────────────────────────────────────────────

    /// Clears all cached activation values, forcing recomputation on next forward.
    pub fn clear_values(&mut self) {
        for v in &mut self.values {
            *v = None;
        }
    }

    /// Clears all per-node gradients.
    ///
    /// Note: this does NOT clear the [`ParamStore`] gradients. Call
    /// `params.clear_gradients()` separately if needed.
    pub fn clear_node_gradients(&mut self) {
        for g in &mut self.node_gradients {
            *g = None;
        }
    }

    /// Returns the per-node gradient for a given node ID.
    pub fn get_node_gradient(&self, id: NodeId) -> Option<&Tensor> {
        self.node_gradients.get(id.0).and_then(|g| g.as_ref())
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::cpu::CPUBackend;
    use crate::graph::OpType;
    use crate::params::ParamId;

    /// Build a simple: input(0) * param(1) + param(2) → output(4)
    fn build_linear_arch() -> (Architecture, ParamStore) {
        let mut arch = Architecture::new();
        let mut params = ParamStore::new();

        // Input: [1, 2]
        let _input = arch.input(Tensor::new_zeros(&[1, 2]));

        // Weight: [2, 3]
        let w_id = params.register(Tensor::new_random(&[2, 3]), "weight");
        let _w_node = arch.param(w_id);

        // Bias: [1, 3]
        let b_id = params.register(Tensor::new_zeros(&[1, 3]), "bias");
        let _b_node = arch.param(b_id);

        // MatMul(input, weight)
        let _mm = arch.op(OpType::MatMul, vec![NodeId(0), NodeId(1)]);

        // Add(mm, bias)
        let _out = arch.op(OpType::Add, vec![NodeId(3), NodeId(2)]);

        (arch, params)
    }

    #[test]
    fn test_engine_forward() {
        let (mut arch, params) = build_linear_arch();
        let mut engine = ExecutionEngine::new(Box::new(CPUBackend));

        // Set input data
        if let Some(Node::Input(t)) = arch.nodes_mut().get_mut(0) {
            let slice = t.as_slice_mut().unwrap();
            slice[0] = 1.0;
            slice[1] = 2.0;
        }

        let result = engine.forward(&arch, &params, NodeId(4)).unwrap();
        assert_eq!(result.shape(), &[1, 3]);
    }

    #[test]
    fn test_engine_forward_with_order() {
        let (mut arch, params) = build_linear_arch();
        let mut engine = ExecutionEngine::new(Box::new(CPUBackend));

        if let Some(Node::Input(t)) = arch.nodes_mut().get_mut(0) {
            let slice = t.as_slice_mut().unwrap();
            slice[0] = 1.0;
            slice[1] = 2.0;
        }

        let order = arch.topological_sort(NodeId(4)).unwrap();
        let r1 = engine.forward_with_order(&arch, &params, &order, NodeId(4)).unwrap();
        let r2 = engine.forward_with_order(&arch, &params, &order, NodeId(4)).unwrap();

        // Same input → same output (deterministic)
        assert_eq!(r1.as_slice().unwrap(), r2.as_slice().unwrap());
    }

    #[test]
    fn test_engine_backward() {
        let (mut arch, mut params) = build_linear_arch();
        let mut engine = ExecutionEngine::new(Box::new(CPUBackend));

        if let Some(Node::Input(t)) = arch.nodes_mut().get_mut(0) {
            let slice = t.as_slice_mut().unwrap();
            slice[0] = 1.0;
            slice[1] = -1.0;
        }

        // Forward
        let result = engine.forward(&arch, &params, NodeId(4)).unwrap();

        // Backward with unit gradient
        let grad = Tensor::from_elem(result.shape(), 1.0);
        engine.backward(&arch, &mut params, NodeId(4), grad).unwrap();

        // Weight gradient should be non-zero
        let w_grad = params.gradient(ParamId(0)).expect("Weight should have gradient");
        let sum_abs: f32 = w_grad.as_slice().unwrap().iter().map(|x| x.abs()).sum();
        assert!(sum_abs > 0.0, "Weight gradient should be non-zero");

        // Bias gradient should be non-zero
        let b_grad = params.gradient(ParamId(1)).expect("Bias should have gradient");
        let b_sum: f32 = b_grad.as_slice().unwrap().iter().map(|x| x.abs()).sum();
        assert!(b_sum > 0.0, "Bias gradient should be non-zero");
    }

    #[test]
    fn test_engine_execute_single_node() {
        let (mut arch, params) = build_linear_arch();
        let mut engine = ExecutionEngine::new(Box::new(CPUBackend));

        if let Some(Node::Input(t)) = arch.nodes_mut().get_mut(0) {
            let slice = t.as_slice_mut().unwrap();
            slice[0] = 1.0;
            slice[1] = 2.0;
        }

        // Sync params first
        engine.sync_params(&arch, &params).unwrap();

        // Execute nodes in order
        let order = arch.topological_sort(NodeId(4)).unwrap();
        for &nid in &order {
            engine.execute_single_node(&arch, &params, nid).unwrap();
        }

        // Check output exists
        assert!(engine.values()[4].is_some());
    }

    #[test]
    fn test_engine_clear() {
        let (arch, params) = build_linear_arch();
        let mut engine = ExecutionEngine::new(Box::new(CPUBackend));

        engine.forward(&arch, &params, NodeId(4)).unwrap();
        assert!(engine.values().iter().any(|v| v.is_some()));

        engine.clear_values();
        assert!(engine.values().iter().all(|v| v.is_none()));
    }
}
