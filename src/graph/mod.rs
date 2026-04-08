pub mod architecture;
pub mod engine;
pub mod dsl;
pub mod verifier;

pub use architecture::Architecture;
pub use engine::ExecutionEngine;

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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum OpType {
    MatMul,
    Conv2D { stride: usize, padding: usize },
    MaxPool2D { kernel_size: usize, stride: usize },
    Add,
    Mul,
    ReLU,
    Tanh,
    Sigmoid,
    Reshape { target_shape: Vec<usize> },
    AddReLU, // Fused operation for optimizer
    Custom(Box<dyn Operation>),
}

impl OpType {
    pub fn name(&self) -> &str {
        match self {
            OpType::MatMul => "MatMul",
            OpType::Conv2D { .. } => "Conv2D",
            OpType::MaxPool2D { .. } => "MaxPool2D",
            OpType::Add => "Add",
            OpType::Mul => "Mul",
            OpType::ReLU => "ReLU",
            OpType::Tanh => "Tanh",
            OpType::Sigmoid => "Sigmoid",
            OpType::Reshape { .. } => "Reshape",
            OpType::AddReLU => "AddReLU (Fused)",
            OpType::Custom(op) => op.name(),
        }
    }

    pub fn forward(&self, inputs: &[&Tensor], backend: &dyn Backend) -> GPResult<Tensor> {
        match self {
            OpType::MatMul => backend.matmul_t(inputs[0], inputs[1], false, false),
            OpType::Conv2D { stride, padding } => backend.conv2d(inputs[0], inputs[1], *stride, *padding),
            OpType::MaxPool2D { kernel_size, stride } => backend.max_pool2d(inputs[0], *kernel_size, *stride),
            OpType::Add => backend.add(inputs[0], inputs[1]),
            OpType::Mul => backend.mul(inputs[0], inputs[1]),
            OpType::ReLU => backend.relu(inputs[0]),
            OpType::Tanh => backend.tanh(inputs[0]),
            OpType::Sigmoid => backend.sigmoid(inputs[0]),
            OpType::Reshape { target_shape } => {
                let mut t = inputs[0].clone();
                t = t.into_shape(target_shape.as_slice())?.into_dyn();
                Ok(t)
            }
            OpType::AddReLU => backend.add_relu(inputs[0], inputs[1]),
            OpType::Custom(op) => op.forward(inputs, backend),
        }
    }

    pub fn forward_inplace(&self, inputs: &[&Tensor], out: &mut Tensor, backend: &dyn Backend) -> GPResult<()> {
        match self {
            OpType::MatMul => backend.matmul_into(inputs[0], inputs[1], false, false, out),
            OpType::Add => backend.add_into(inputs[0], inputs[1], out),
            OpType::Mul => backend.mul_into(inputs[0], inputs[1], out),
            OpType::ReLU => {
                let out_shape = out.shape().to_vec();
                let in_shape = inputs[0].shape().to_vec();
                let out_len = out.len();
                let in_len = inputs[0].len();
                
                let out_slice = out.as_slice_mut()?;
                let in_slice = inputs[0].as_slice()?;
                
                if out_len != in_len {
                    return Err(GPError::IncompatibleShapes { 
                        expected: out_shape, 
                        found: in_shape,
                        exp_len: out_len,
                        found_len: in_len,
                    });
                }
                for i in 0..out_slice.len() {
                    out_slice[i] = if in_slice[i] < 0.0 { 0.0 } else { in_slice[i] };
                }
                Ok(())
            }
            OpType::Tanh => {
                let out_shape = out.shape().to_vec();
                let in_shape = inputs[0].shape().to_vec();
                let out_len = out.len();
                let in_len = inputs[0].len();
                
                let out_slice = out.as_slice_mut()?;
                let in_slice = inputs[0].as_slice()?;
                
                if out_len != in_len {
                    return Err(GPError::IncompatibleShapes { 
                        expected: out_shape, 
                        found: in_shape,
                        exp_len: out_len,
                        found_len: in_len,
                    });
                }
                for i in 0..out_slice.len() {
                    out_slice[i] = in_slice[i].tanh();
                }
                Ok(())
            }
            OpType::Sigmoid => {
                // println!("Sigmoid: Start");
                let out_shape = out.shape().to_vec();
                let in_shape = inputs[0].shape().to_vec();
                let out_len = out.len();
                let in_len = inputs[0].len();

                let out_slice = out.as_slice_mut()?;
                let in_slice = inputs[0].as_slice()?;

                if out_len != in_len {
                    return Err(GPError::IncompatibleShapes { 
                        expected: out_shape, 
                        found: in_shape,
                        exp_len: out_len,
                        found_len: in_len,
                    });
                }
                for i in 0..out_slice.len() {
                    let val = 1.0 / (1.0 + (-in_slice[i]).exp());
                    // println!("Sigmoid: idx {} -> {}", i, val);
                    out_slice[i] = val;
                }
                // println!("Sigmoid: End");
                Ok(())
            }
            OpType::AddReLU => {
                backend.relu_inplace(out)?;
                Ok(())
            }
            OpType::Custom(op) => op.forward_inplace(inputs, out, backend),
            _ => {
                // Fallback for complex ops: compute and copy via slice
                let res = self.forward(inputs, backend)?;
                out.copy_from(&res)?;
                Ok(())
            }
        }
    }

    pub fn backward(&self, inputs: &[&Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        match self {
            OpType::MatMul => {
                let grad_a = backend.matmul_t(grad_output, &inputs[1], false, true)?;
                let grad_b = backend.matmul_t(&inputs[0], grad_output, true, false)?;
                Ok(vec![grad_a, grad_b])
            }
            OpType::Conv2D { stride, padding } => {
                let (gi, gw) = backend.conv2d_backward(&inputs[0], &inputs[1], grad_output, *stride, *padding)?;
                Ok(vec![gi, gw])
            }
            OpType::MaxPool2D { kernel_size, stride } => {
                Ok(vec![backend.max_pool2d_backward(&inputs[0], grad_output, *kernel_size, *stride)?])
            }
            OpType::Add => {
                Ok(vec![
                    self.resolve_grad(inputs[0].shape(), grad_output, backend)?,
                    self.resolve_grad(inputs[1].shape(), grad_output, backend)?
                ])
            }
            OpType::Mul => {
                let (grad_a, grad_b) = backend.mul_backward(inputs[0], inputs[1], grad_output)?;
                Ok(vec![
                    self.resolve_grad(inputs[0].shape(), &grad_a, backend)?,
                    self.resolve_grad(inputs[1].shape(), &grad_b, backend)?
                ])
            }
            OpType::ReLU => Ok(vec![backend.relu_backward(&inputs[0], grad_output)?]),
            OpType::Tanh => {
                let y = backend.tanh(&inputs[0])?;
                Ok(vec![backend.tanh_backward(&y, grad_output)?])
            },
            OpType::Sigmoid => {
                let y = backend.sigmoid(&inputs[0])?; 
                Ok(vec![backend.sigmoid_backward(&y, grad_output)?])
            }
            OpType::Reshape { .. } => {
                let original_shape = inputs[0].shape();
                let mut grad = grad_output.clone();
                grad = grad.into_shape(original_shape)?.into_dyn();
                Ok(vec![grad])
            }
            OpType::AddReLU => {
                // ReLU gradient * Add gradient
                let relu_grad = backend.relu_backward(&backend.add(&inputs[0], &inputs[1])?, grad_output)?;
                Ok(vec![
                    self.resolve_grad(inputs[0].shape(), &relu_grad, backend)?,
                    self.resolve_grad(inputs[1].shape(), &relu_grad, backend)?
                ])
            }
            OpType::Custom(op) => op.backward(inputs, grad_output, backend),
        }
    }

    pub fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        match self {
            OpType::MatMul => {
                if input_shapes[0][1] != input_shapes[1][0] {
                    return Err(GPError::IncompatibleShapes { 
                        expected: vec![input_shapes[0][0], input_shapes[1][0]], 
                        found: vec![input_shapes[0][1], input_shapes[1][0]],
                        exp_len: input_shapes[0][1],
                        found_len: input_shapes[1][0],
                    });
                }
                Ok(vec![input_shapes[0][0], input_shapes[1][1]])
            }
            OpType::Conv2D { stride, padding } => {
                let (n, _ci, h, w) = (input_shapes[0][0], input_shapes[0][1], input_shapes[0][2], input_shapes[0][3]);
                let (co, _ci_w, kh, kw) = (input_shapes[1][0], input_shapes[1][1], input_shapes[1][2], input_shapes[1][3]);
                let oh = (h + 2 * padding - kh) / stride + 1;
                let ow = (w + 2 * padding - kw) / stride + 1;
                Ok(vec![n, co, oh, ow])
            }
            OpType::MaxPool2D { kernel_size, stride } => {
                let (n, c, h, w) = (input_shapes[0][0], input_shapes[0][1], input_shapes[0][2], input_shapes[0][3]);
                let oh = (h - kernel_size) / stride + 1;
                let ow = (w - kernel_size) / stride + 1;
                Ok(vec![n, c, oh, ow])
            }
            OpType::Add | OpType::Mul | OpType::AddReLU => {
                if input_shapes[0] != input_shapes[1] {
                     let exp_total: usize = input_shapes[0].iter().product();
                     let found_total: usize = input_shapes[1].iter().product();
                    return Err(GPError::IncompatibleShapes { 
                        expected: input_shapes[0].clone(), 
                        found: input_shapes[1].clone(),
                        exp_len: exp_total,
                        found_len: found_total,
                    });
                }
                Ok(input_shapes[0].clone())
            }
            OpType::ReLU | OpType::Sigmoid | OpType::Tanh => Ok(input_shapes[0].clone()),
            OpType::Reshape { target_shape } => Ok(target_shape.clone()),
            OpType::Custom(op) => op.output_shape(input_shapes),
        }
    }

    fn resolve_grad(&self, target_shape: &[usize], grad: &Tensor, backend: &dyn Backend) -> GPResult<Tensor> {
        if target_shape == grad.shape() {
            return Ok(grad.clone());
        }
        let grad_dims = grad.shape().len();
        let target_dims = target_shape.len();
        let mut axes_to_reduce = Vec::new();
        if grad_dims > target_dims {
            for i in 0..(grad_dims - target_dims) {
                axes_to_reduce.push(i);
            }
        }
        for i in 0..target_dims {
            let g_idx = grad_dims - 1 - i;
            let t_idx = target_dims - 1 - i;
            if target_shape[t_idx] == 1 && grad.shape()[g_idx] > 1 {
                axes_to_reduce.push(g_idx);
            }
        }
        if axes_to_reduce.is_empty() {
             return Ok(grad.clone());
        }
        backend.reduce_sum(grad, &axes_to_reduce, true)
            .and_then(|t| {
                if t.shape().len() != target_shape.len() {
                     let val = t.try_view()?.to_owned().into_shape(target_shape)
                         .map_err(|_e| GPError::IncompatibleShapes { 
                             expected: target_shape.to_vec(), 
                             found: t.shape().to_vec(),
                             exp_len: target_shape.iter().product(),
                             found_len: t.len(),
                         })?;
                     Ok(val.into_dyn().into())
                } else {
                     Ok(t)
                }
            })
    }
}

// Trait remains for compatibility where needed, though we moved to enum for core WASM stability
#[typetag::serde(tag = "type")]
pub trait Operation: Send + Sync + std::fmt::Debug {
    fn name(&self) -> &str;
    fn forward(&self, inputs: &[&Tensor], backend: &dyn Backend) -> GPResult<Tensor>;
    fn backward(&self, inputs: &[&Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>>;
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>>;
    
    // Optional: inplace version for performance
    fn forward_inplace(&self, inputs: &[&Tensor], out: &mut Tensor, backend: &dyn Backend) -> GPResult<()> {
        let res = self.forward(inputs, backend)?;
        out.copy_from(&res)
    }

    fn clone_box(&self) -> Box<dyn Operation>;
}

impl Clone for Box<dyn Operation> {
    fn clone(&self) -> Self {
        self.clone_box()
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
        let trainable = self.param_store.trainable_params_with_grads();
        for (_param_id, tensor, grad) in trainable {
            backend.update_parameter(tensor, grad, learning_rate)?;
        }
        Ok(())
    }
}
