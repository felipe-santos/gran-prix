pub mod dsl;
pub mod optimizer;
pub mod memory_planner;
pub mod verifier;
pub mod buffer_pool;

use crate::backend::Backend;
use crate::{GPError, GPResult, Tensor, NodeId};
use serde::{Serialize, Deserialize};


/// A node in the computation graph.
#[derive(Serialize, Deserialize)]
pub enum Node {
    Input(Tensor),
    Param(Tensor), // Trainable parameters
    Op {
        op: OpType,
        inputs: Vec<NodeId>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum OpType {
    MatMul,
    Conv2D { stride: usize, padding: usize },
    MaxPool2D { kernel_size: usize, stride: usize },
    Add,
    ReLU,
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
            OpType::ReLU => "ReLU",
            OpType::Sigmoid => "Sigmoid",
            OpType::Reshape { .. } => "Reshape",
            OpType::AddReLU => "AddReLU",
            OpType::Custom(op) => op.name(),
        }
    }

    pub fn forward(&self, inputs: &[&Tensor], backend: &dyn Backend) -> GPResult<Tensor> {
        match self {
            OpType::MatMul => backend.matmul_t(inputs[0], inputs[1], false, false),
            OpType::Conv2D { stride, padding } => backend.conv2d(inputs[0], inputs[1], *stride, *padding),
            OpType::MaxPool2D { kernel_size, stride } => backend.max_pool2d(inputs[0], *kernel_size, *stride),
            OpType::Add => backend.add(inputs[0], inputs[1]),
            OpType::ReLU => backend.relu(inputs[0]),
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
                let shape_a = inputs[0].shape();
                let shape_b = inputs[1].shape();
                Ok(vec![
                    self.resolve_grad(shape_a, grad_output, backend)?,
                    self.resolve_grad(shape_b, grad_output, backend)?
                ])
            }
            OpType::ReLU => Ok(vec![backend.relu_backward(&inputs[0], grad_output)?]),
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
            OpType::Add | OpType::AddReLU => {
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
            OpType::ReLU | OpType::Sigmoid => Ok(input_shapes[0].clone()),
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


/// The Execution Graph (Planta).
#[derive(Serialize, Deserialize)]
pub struct Graph {
    nodes: Vec<Node>,
    #[serde(skip)]
    backend: Option<Box<dyn Backend>>,
    /// Cache of values from the last forward pass
    #[serde(skip)]
    values: Vec<Option<Tensor>>,
    /// Accumulated gradients
    #[serde(skip)]
    gradients: Vec<Option<Tensor>>,
    /// Memory reuse plan
    #[serde(skip)]
    pub memory_plan: Option<memory_planner::MemoryPlanner>,
    /// Pre-allocated buffers
    #[serde(skip)]
    pub buffer_pool: Option<buffer_pool::BufferPool>,
}

impl Graph {
    pub fn new(backend: Box<dyn Backend>) -> Self {
        Self {
            nodes: Vec::new(),
            backend: Some(backend),
            values: Vec::new(),
            gradients: Vec::new(),
            memory_plan: None,
            buffer_pool: None,
        }
    }

    /// Sets the backend after deserialization and initializes internal state
    pub fn set_backend(&mut self, backend: Box<dyn Backend>) {
        self.backend = Some(backend);
        // Re-initialize caches after deserialization
        if self.values.len() < self.nodes.len() {
            self.values.resize(self.nodes.len(), None);
        }
        if self.gradients.len() < self.nodes.len() {
            self.gradients.resize(self.nodes.len(), None);
        }
    }

    pub fn input(&mut self, tensor: Tensor) -> NodeId {
        let id = NodeId(self.nodes.len());
        self.nodes.push(Node::Input(tensor));
        self.values.push(None);
        self.gradients.push(None);
        id
    }

    pub fn param(&mut self, tensor: Tensor) -> NodeId {
        let id = NodeId(self.nodes.len());
        self.nodes.push(Node::Param(tensor));
        self.values.push(None);
        self.gradients.push(None);
        id
    }

    pub fn op(&mut self, op: OpType, inputs: Vec<NodeId>) -> NodeId {
        let id = NodeId(self.nodes.len());
        self.nodes.push(Node::Op { op, inputs });
        self.values.push(None);
        self.gradients.push(None);
        id
    }

    /// Forward pass: Computes and caches values using iterative execution.
    pub fn execute(&mut self, target: NodeId) -> GPResult<Tensor> {
        let order = self.topological_sort(target)?;
        let backend = self.backend.as_deref().ok_or(GPError::BackendNotInitialized)?;

        // PARANOID: Ensure values vector is long enough for all nodes before splitting
        if self.values.len() < self.nodes.len() {
            self.values.resize(self.nodes.len(), None);
        }

        for node_id in order {
            // Check index validity to prevent OOB before split_at_mut
            if node_id.0 >= self.nodes.len() || node_id.0 >= self.values.len() {
                return Err(GPError::InferenceError(format!("PRIX: Node index {} out of bounds", node_id.0)));
            }

            match &self.nodes[node_id.0] {
                Node::Input(t) => {
                    // Always update input, but try to avoid reallocation if shape matches
                    if let Some(Some(cached)) = self.values.get_mut(node_id.0) {
                        if cached.shape() == t.shape() {
                            cached.copy_from(t)?;
                        } else {
                            *cached = t.clone();
                        }
                    } else {
                        if self.values.len() <= node_id.0 { self.values.resize(node_id.0 + 1, None); }
                        self.values[node_id.0] = Some(t.clone());
                    }
                }
                Node::Param(t) => {
                    if self.values[node_id.0].is_none() {
                        self.values[node_id.0] = Some(t.clone());
                    }
                }
                Node::Op { op, inputs } => {
                    // Safety: Split the values to borrow inputs (left) and output (right[0])
                    let (left, right) = self.values.split_at_mut(node_id.0);
                    let out_opt = &mut right[0];

                    let mut input_refs = Vec::with_capacity(inputs.len());
                    for &input_id in inputs {
                        // All inputs in a topological sort MUST be to the left of the current node
                        if input_id.0 >= node_id.0 || input_id.0 >= left.len() {
                            return Err(GPError::InferenceError(format!("Input node {:?} is invalid or not before node {:?}", input_id, node_id)));
                        }
                        input_refs.push(left[input_id.0].as_ref()
                            .ok_or_else(|| GPError::InferenceError(format!("Input value not found for node {:?}", input_id)))?);
                    }
                    
                    if let Some(out) = out_opt {
                        // REUSE BUFFER
                        op.forward_inplace(&input_refs, out, backend)?;
                    } else {
                        // ALLOCATE (First frame only)
                        let val = op.forward(&input_refs, backend)?;
                        *out_opt = Some(val);
                    }
                }
            };
        }

        self.values[target.0].as_ref().cloned()
            .ok_or_else(|| GPError::InferenceError(format!("Target node {:?} not computed", target)))
    }

    /// DEBUG ONLY: Executa um único nó para permitir rastreamento de corrupção entre chamadas
    pub fn execute_single_node(&mut self, node_id: NodeId) -> GPResult<()> {
        let backend = self.backend.as_deref().ok_or(GPError::BackendNotInitialized)?;
        
        if self.values.len() < self.nodes.len() {
            self.values.resize(self.nodes.len(), None);
        }

        match &self.nodes[node_id.0] {
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
            Node::Param(t) => {
                if self.values[node_id.0].is_none() {
                    self.values[node_id.0] = Some(t.clone());
                }
            }
            Node::Op { op, inputs } => {
                let (left, right) = self.values.split_at_mut(node_id.0);
                let out_opt = &mut right[0];

                let mut input_refs = Vec::with_capacity(inputs.len());
                for &input_id in inputs {
                    input_refs.push(left[input_id.0].as_ref()
                        .ok_or_else(|| GPError::InferenceError(format!("Value not found for node {:?}", input_id)))?);
                }
                
                if let Some(out) = out_opt {
                    op.forward_inplace(&input_refs, out, backend)?;
                } else {
                    let val = op.forward(&input_refs, backend)?;
                    *out_opt = Some(val);
                }
            }
        };
        Ok(())
    }

    pub fn values(&self) -> &[Option<Tensor>] {
        &self.values
    }

    /// Plans memory reuse for the current graph.
    pub fn plan_memory(&mut self) -> GPResult<()> {
        let planner = memory_planner::MemoryPlanner::plan(self)?;
        let pool = buffer_pool::BufferPool::new(planner.buffer_count);
        self.memory_plan = Some(planner);
        self.buffer_pool = Some(pool);
        Ok(())
    }

    /// Backward pass: Propagates gradients using iterative execution (reverse topological order).
    pub fn backward(&mut self, target: NodeId, grad_output: Tensor) -> GPResult<()> {
        let order = self.topological_sort(target)?;
        let backend = self.backend.as_deref().ok_or(GPError::BackendNotInitialized)?;

        if self.gradients.len() < self.nodes.len() {
            self.gradients.resize(self.nodes.len(), None);
        }

        // Initialize/Accumulate target gradient
        if let Some(existing) = &self.gradients[target.0] {
            self.gradients[target.0] = Some(existing + &grad_output);
        } else {
            self.gradients[target.0] = Some(grad_output);
        }

        // Process in reverse topological order
        for &node_id in order.iter().rev() {
            let grad = match self.gradients[node_id.0].take() {
                Some(g) => g,
                None => continue, // No gradient for this node
            };
            
            // Put it back because we might need it for parameter update or further accumulation
            self.gradients[node_id.0] = Some(grad.clone());

            let (op, inputs) = match &self.nodes[node_id.0] {
                Node::Op { op, inputs } => (op, inputs),
                _ => continue, // Leaf nodes don't propagate gradients
            };

            let mut input_refs = Vec::with_capacity(inputs.len());
            for &id in inputs {
                input_refs.push(self.values[id.0].as_ref()
                    .ok_or_else(|| GPError::InferenceError(format!("Value not found for node {:?}", id)))?);
            }

            let input_grads = op.backward(&input_refs, &grad, backend)?;
            for (i, &input_id) in inputs.iter().enumerate() {
                if let Some(existing) = &self.gradients[input_id.0] {
                    self.gradients[input_id.0] = Some(existing + &input_grads[i]);
                } else {
                    self.gradients[input_id.0] = Some(input_grads[i].clone());
                }
            }
        }
        Ok(())
    }

    /// Computes topological order of nodes required for the target node (Iterative).
    pub fn topological_sort(&self, target: NodeId) -> GPResult<Vec<NodeId>> {
        let mut order = Vec::new();
        let mut visited = vec![false; self.nodes.len()];
        let mut on_stack = vec![false; self.nodes.len()];
        let mut stack = vec![(target, false)]; // (node_id, processed_children)

        while let Some((id, processed)) = stack.pop() {
            if processed {
                on_stack[id.0] = false;
                order.push(id);
                continue;
            }

            if visited[id.0] {
                continue;
            }

            if on_stack[id.0] {
                return Err(GPError::InferenceError("Cycle detected in graph".to_string()));
            }

            visited[id.0] = true;
            on_stack[id.0] = true;
            stack.push((id, true));

            if let Node::Op { inputs, .. } = &self.nodes[id.0] {
                for &input_id in inputs.iter().rev() {
                    stack.push((input_id, false));
                }
            }
        }
        Ok(order)
    }

    pub fn get_gradient(&self, id: NodeId) -> Option<&Tensor> {
        self.gradients.get(id.0).and_then(|g: &Option<Tensor>| g.as_ref())
    }

    pub fn nodes(&self) -> &[Node] {
        &self.nodes
    }

    pub fn nodes_mut(&mut self) -> &mut [Node] {
        &mut self.nodes
    }

    pub fn clear_values(&mut self) {
        // Only clear if we really want to force recomputation or if we are training.
        // For inference stabilization, we might prefer a reset() that keeps buffers.
    }

    /// Mark all values as needing recomputation while KEEPING the heap buffers.
    pub fn reset_values(&mut self) {
        // Currently, we use None as the "needs recomputation" signal.
        // To reach 0 allocations, we need a separate bitset or just always recompute OPs.
        // For now, let's just make clear_values NOT set to None if they already exist?
        // No, that would break the current logic.
    }

    pub fn clear_gradients(&mut self) {
        for g in &mut self.gradients {
            *g = None;
        }
    }

    /// Mutates parameters based on gradients and a learning rate.
    /// This is a basic form of SGD implementation.
    pub fn update_parameters(&mut self, learning_rate: f32) -> GPResult<()> {
        let backend = self.backend.as_ref().ok_or(GPError::BackendNotInitialized)?;
        for i in 0..self.nodes.len() {
            if let Some(grad) = &self.gradients[i] {
                if let Node::Param(ref mut param) = &mut self.nodes[i] {
                    backend.update_parameter(param, grad, learning_rate)?;
                }
            }
        }
        Ok(())
    }
}
