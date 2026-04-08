pub mod architecture;
pub mod engine;
pub mod ops;
pub mod dsl;
pub mod verifier;

pub use architecture::Architecture;
pub use engine::ExecutionEngine;
pub use ops::{OpType, Operation};

use crate::backend::Backend;
use crate::{GPError, GPResult, Tensor, NodeId};
use crate::params::{ParamStore, ParamId};
use serde::{Serialize, Deserialize};


/// A node in the computation graph.
///
/// Parameter tensors are stored externally in [`ParamStore`] and referenced
/// by [`ParamId`]. This decouples parameter management from graph topology.
#[derive(Serialize, Deserialize)]
pub enum Node {
    Input(Tensor),
    Param(ParamId),
    Op {
        op: OpType,
        inputs: Vec<NodeId>,
    },
}

impl Node {
    pub fn op(&self) -> Option<&OpType> {
        match self {
            Node::Op { op, .. } => Some(op),
            _ => None,
        }
    }

    pub fn inputs(&self) -> Option<&[NodeId]> {
        match self {
            Node::Op { inputs, .. } => Some(inputs),
            _ => None,
        }
    }

    /// Returns the ParamId if this is a Param node.
    pub fn param_id(&self) -> Option<ParamId> {
        match self {
            Node::Param(id) => Some(*id),
            _ => None,
        }
    }
}

/// The Execution Graph — high-level facade composing topology, parameters, and execution.
///
/// `Graph` composes three independent components:
/// - [`Architecture`] — DAG topology (nodes and connections)
/// - [`ParamStore`] — trainable parameter tensors and gradients
/// - [`ExecutionEngine`] — backend, value cache, forward/backward
///
/// For advanced use cases, access each component directly via
/// `graph.arch()`, `graph.params()`, `graph.engine()`.
///
/// # Serialization
///
/// Only `Architecture` and `ParamStore` are serialized. The `ExecutionEngine`
/// must be recreated after deserialization via `set_backend()`.
#[derive(Serialize, Deserialize)]
pub struct Graph {
    /// Computation graph topology.
    arch: Architecture,
    /// Trainable parameter tensors.
    pub(crate) param_store: ParamStore,
    /// Execution engine (backend + caches). Skipped during serialization.
    #[serde(skip)]
    engine: Option<ExecutionEngine>,
}

impl Graph {
    pub fn new(backend: Box<dyn Backend>) -> Self {
        Self {
            arch: Architecture::new(),
            param_store: ParamStore::new(),
            engine: Some(ExecutionEngine::new(backend)),
        }
    }

    /// Sets the backend after deserialization, creating a fresh execution engine.
    pub fn set_backend(&mut self, backend: Box<dyn Backend>) {
        self.engine = Some(ExecutionEngine::new(backend));
    }

    // ── Component Access ───────────────────────────────────────────────────

    /// Returns a reference to the graph topology.
    pub fn arch(&self) -> &Architecture {
        &self.arch
    }

    /// Returns a mutable reference to the graph topology.
    pub fn arch_mut(&mut self) -> &mut Architecture {
        &mut self.arch
    }

    /// Returns a reference to the parameter store.
    pub fn params(&self) -> &ParamStore {
        &self.param_store
    }

    /// Returns a mutable reference to the parameter store.
    pub fn params_mut(&mut self) -> &mut ParamStore {
        &mut self.param_store
    }

    /// Returns a reference to the execution engine.
    pub fn engine(&self) -> Option<&ExecutionEngine> {
        self.engine.as_ref()
    }

    /// Returns a mutable reference to the execution engine.
    pub fn engine_mut(&mut self) -> Option<&mut ExecutionEngine> {
        self.engine.as_mut()
    }

    // ── Node Construction (delegates to Architecture) ──────────────────────

    pub fn input(&mut self, tensor: Tensor) -> NodeId {
        self.arch.input(tensor)
    }

    /// Registers a parameter tensor in the [`ParamStore`] and adds a
    /// `Node::Param` to the architecture.
    pub fn param(&mut self, tensor: Tensor) -> NodeId {
        let param_id = self.param_store.register(tensor, "");
        self.arch.param(param_id)
    }

    /// Registers a named parameter tensor and adds a node for it.
    pub fn named_param(&mut self, tensor: Tensor, name: &str) -> NodeId {
        let param_id = self.param_store.register(tensor, name);
        self.arch.param(param_id)
    }

    pub fn op(&mut self, op: OpType, inputs: Vec<NodeId>) -> NodeId {
        self.arch.op(op, inputs)
    }

    // ── Execution (delegates to ExecutionEngine) ───────────────────────────
    //
    // Note: We access `self.engine` via direct field destructuring to
    // satisfy the borrow checker (split borrows across struct fields).

    /// Forward pass: computes and caches values using iterative execution.
    pub fn execute(&mut self, target: NodeId) -> GPResult<Tensor> {
        let engine = self.engine.as_mut().ok_or(GPError::BackendNotInitialized)?;
        engine.forward(&self.arch, &self.param_store, target)
    }

    /// Forward pass using a pre-computed topological order.
    pub fn execute_with_order(&mut self, order: &[NodeId], target: NodeId) -> GPResult<Tensor> {
        let engine = self.engine.as_mut().ok_or(GPError::BackendNotInitialized)?;
        engine.forward_with_order(&self.arch, &self.param_store, order, target)
    }

    /// Executes a single node (used by WASM bridge for per-node execution).
    pub fn execute_single_node(&mut self, node_id: NodeId) -> GPResult<()> {
        let engine = self.engine.as_mut().ok_or(GPError::BackendNotInitialized)?;
        engine.execute_single_node(&self.arch, &self.param_store, node_id)
    }

    /// Backward pass: computes gradients via reverse-mode autodiff.
    pub fn backward(&mut self, target: NodeId, grad_output: Tensor) -> GPResult<()> {
        let engine = self.engine.as_mut().ok_or(GPError::BackendNotInitialized)?;
        engine.backward(&self.arch, &mut self.param_store, target, grad_output)
    }

    // ── Cache Access (delegates to ExecutionEngine) ────────────────────────

    /// Returns cached activation values from the last forward pass.
    pub fn values(&self) -> &[Option<Tensor>] {
        match &self.engine {
            Some(e) => e.values(),
            None => &[],
        }
    }

    /// Clears cached activation values.
    pub fn clear_values(&mut self) {
        if let Some(e) = &mut self.engine {
            e.clear_values();
        }
    }

    /// Clears all gradients (both node-level and parameter store).
    pub fn clear_gradients(&mut self) {
        if let Some(e) = &mut self.engine {
            e.clear_node_gradients();
        }
        self.param_store.clear_gradients();
    }

    /// Syncs parameter tensors into the execution cache.
    pub fn sync_params(&mut self) -> GPResult<()> {
        let engine = self.engine.as_mut().ok_or(GPError::BackendNotInitialized)?;
        engine.sync_params(&self.arch, &self.param_store)
    }

    /// Returns the gradient for a node.
    ///
    /// Checks engine node-gradients first, then parameter store.
    pub fn get_gradient(&self, id: NodeId) -> Option<&Tensor> {
        if let Some(engine) = &self.engine {
            if let Some(grad) = engine.get_node_gradient(id) {
                return Some(grad);
            }
        }
        if let Some(Node::Param(param_id)) = self.arch.get_node(id) {
            return self.param_store.gradient(*param_id);
        }
        None
    }

    // ── Topology Access (delegates to Architecture) ────────────────────────

    /// Returns a reference to all nodes.
    pub fn nodes(&self) -> &[Node] {
        self.arch.nodes()
    }

    /// Returns a mutable reference to all nodes.
    pub fn nodes_mut(&mut self) -> &mut [Node] {
        self.arch.nodes_mut()
    }

    /// Computes topological execution order for the target node.
    pub fn topological_sort(&self, target: NodeId) -> GPResult<Vec<NodeId>> {
        self.arch.topological_sort(target)
    }

    /// Updates parameters using a simple SGD step: param -= lr * grad.
    pub fn update_parameters(&mut self, learning_rate: f32) -> GPResult<()> {
        let engine = self.engine.as_ref().ok_or(GPError::BackendNotInitialized)?;
        let backend = engine.backend();
        let ids = self.param_store.trainable_param_ids();
        for id in ids {
            if let Some((tensor, grad)) = self.param_store.param_and_grad(id) {
                backend.update_parameter(tensor, grad, learning_rate)?;
            }
        }
        Ok(())
    }
}
