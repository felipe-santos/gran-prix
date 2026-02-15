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
        op: Box<dyn Operation>,
        inputs: Vec<NodeId>,
    },
}

impl Node {
    pub fn op(&self) -> Option<&dyn Operation> {
        if let Node::Op { op, .. } = self {
            Some(op.as_ref())
        } else {
            None
        }
    }
}

/// A generic operation in the DAG.
#[typetag::serde]
pub trait Operation: Send + Sync {
    fn name(&self) -> &str;
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> GPResult<Tensor>;
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>>;
    
    /// Static shape inference: Determines output shape without computing values.
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>>;
}

// --- Concrete Operations ---

#[derive(Serialize, Deserialize)]
pub struct MatMul;
#[typetag::serde]
impl Operation for MatMul {
    fn name(&self) -> &str { "MatMul" }
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> GPResult<Tensor> {
        backend.matmul_t(&inputs[0], &inputs[1], false, false)
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        // grad_A = grad_output * B^T
        let grad_a = backend.matmul_t(grad_output, &inputs[1], false, true)?;
        // grad_B = A^T * grad_output
        let grad_b = backend.matmul_t(&inputs[0], grad_output, true, false)?;
        Ok(vec![grad_a, grad_b])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        if input_shapes[0][1] != input_shapes[1][0] {
            return Err(GPError::IncompatibleShapes { 
                expected: vec![input_shapes[0][0], input_shapes[1][0]], 
                found: vec![input_shapes[0][1], input_shapes[1][0]] 
            });
        }
        Ok(vec![input_shapes[0][0], input_shapes[1][1]])
    }
}

#[derive(Serialize, Deserialize)]
pub struct Conv2D {
    pub stride: usize,
    pub padding: usize,
}

#[typetag::serde]
impl Operation for Conv2D {
    fn name(&self) -> &str { "Conv2D" }
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> GPResult<Tensor> {
        backend.conv2d(&inputs[0], &inputs[1], self.stride, self.padding)
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        let (gi, gw) = backend.conv2d_backward(&inputs[0], &inputs[1], grad_output, self.stride, self.padding)?;
        Ok(vec![gi, gw])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        let (n, _ci, h, w) = (input_shapes[0][0], input_shapes[0][1], input_shapes[0][2], input_shapes[0][3]);
        let (co, _ci_w, kh, kw) = (input_shapes[1][0], input_shapes[1][1], input_shapes[1][2], input_shapes[1][3]);
        let oh = (h + 2 * self.padding - kh) / self.stride + 1;
        let ow = (w + 2 * self.padding - kw) / self.stride + 1;
        Ok(vec![n, co, oh, ow])
    }
}

#[derive(Serialize, Deserialize)]
pub struct MaxPool2D {
    pub kernel_size: usize,
    pub stride: usize,
}

#[typetag::serde]
impl Operation for MaxPool2D {
    fn name(&self) -> &str { "MaxPool2D" }
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> GPResult<Tensor> {
        backend.max_pool2d(&inputs[0], self.kernel_size, self.stride)
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        Ok(vec![backend.max_pool2d_backward(&inputs[0], grad_output, self.kernel_size, self.stride)?])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        let (n, c, h, w) = (input_shapes[0][0], input_shapes[0][1], input_shapes[0][2], input_shapes[0][3]);
        let oh = (h - self.kernel_size) / self.stride + 1;
        let ow = (w - self.kernel_size) / self.stride + 1;
        Ok(vec![n, c, oh, ow])
    }
}

#[derive(Serialize, Deserialize)]
pub struct Add;
#[typetag::serde]
impl Operation for Add {
    fn name(&self) -> &str { "Add" }
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> GPResult<Tensor> {
        backend.add(&inputs[0], &inputs[1])
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        let shape_a = inputs[0].shape();
        let shape_b = inputs[1].shape();
        let shape_out = grad_output.shape();

        // Helper to resolve broadcast dimensions
        let resolve_grad = |target_shape: &[usize], grad: &Tensor| -> GPResult<Tensor> {
            if target_shape == grad.shape() {
                return Ok(grad.clone());
            }
            // Identify axes to reduce
            // Broadcasting rules: align from right.
            // If target has fewer dims, reduce leading dims.
            // If dim is 1 in target and >1 in grad, reduce that dim.
            
            let grad_dims = grad.shape().len();
            let target_dims = target_shape.len();
            let mut axes_to_reduce = Vec::new();
            
            // Reduce extra leading dims
            if grad_dims > target_dims {
                for i in 0..(grad_dims - target_dims) {
                    axes_to_reduce.push(i);
                }
            }
            
            // Check matching trailing dims
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
                    // If we reduced leading dims, we might need to reshape to drop them if keep_dims=true kept them as 1?
                    // make sure output shape matches target shape exactly.
                    // Our reduce_sum implementation with keep_dims=true keeps them as 1.
                    // If target has fewer dims, we need to drop leading 1s.
                    if t.shape().len() != target_shape.len() {
                         // Attempt reshape
                         // Should verify total elements match
                         // t.values match target.values (broadcasting validation?)
                         // Just force reshape
                         let val = t.try_view()?.to_owned().into_shape(target_shape)
                             .map_err(|_e| GPError::IncompatibleShapes { expected: target_shape.to_vec(), found: t.shape().to_vec() })?;
                         Ok(val.into_dyn().into())
                    } else {
                         Ok(t)
                    }
                })
        };

        Ok(vec![
            resolve_grad(shape_a, grad_output)?,
            resolve_grad(shape_b, grad_output)?
        ])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        if input_shapes[0] != input_shapes[1] {
            return Err(GPError::IncompatibleShapes { expected: input_shapes[0].clone(), found: input_shapes[1].clone() });
        }
        Ok(input_shapes[0].clone())
    }
}

#[derive(Serialize, Deserialize)]
pub struct ReLUOp;
#[typetag::serde]
impl Operation for ReLUOp {
    fn name(&self) -> &str { "ReLU" }
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> GPResult<Tensor> {
        backend.relu(&inputs[0])
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        Ok(vec![backend.relu_backward(&inputs[0], grad_output)?])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        Ok(input_shapes[0].clone())
    }
}

#[derive(Serialize, Deserialize)]
pub struct SigmoidOp;
#[typetag::serde]
impl Operation for SigmoidOp {
    fn name(&self) -> &str { "Sigmoid" }
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> GPResult<Tensor> {
        backend.sigmoid(&inputs[0])
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        // inputs[0] is X, but sigmoid_backward needs Y = sigmoid(X)
        // For efficiency, some backends might prefer the output Y.
        // Let's assume our backend.sigmoid_backward takes Y.
        let y = backend.sigmoid(&inputs[0])?; 
        Ok(vec![backend.sigmoid_backward(&y, grad_output)?])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        Ok(input_shapes[0].clone())
    }
}

#[derive(Serialize, Deserialize)]
pub struct Reshape {
    pub target_shape: Vec<usize>,
}

#[typetag::serde]
impl Operation for Reshape {
    fn name(&self) -> &str { "Reshape" }
    fn forward(&self, inputs: &[Tensor], _backend: &dyn Backend) -> GPResult<Tensor> {
        let mut t = inputs[0].clone();
        t = t.into_shape(self.target_shape.as_slice())?.into_dyn();
        Ok(t)
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, _backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        let original_shape = inputs[0].shape();
        let mut grad = grad_output.clone();
        grad = grad.into_shape(original_shape)?.into_dyn();
        Ok(vec![grad])
    }
    fn output_shape(&self, _input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        Ok(self.target_shape.clone())
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
}

impl Graph {
    pub fn new(backend: Box<dyn Backend>) -> Self {
        Self {
            nodes: Vec::new(),
            backend: Some(backend),
            values: Vec::new(),
            gradients: Vec::new(),
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

    pub fn op(&mut self, op: Box<dyn Operation>, inputs: Vec<NodeId>) -> NodeId {
        let id = NodeId(self.nodes.len());
        self.nodes.push(Node::Op { op, inputs });
        self.values.push(None);
        self.gradients.push(None);
        id
    }

    /// Forward pass: Computes and caches values
    pub fn execute(&mut self, target: NodeId) -> GPResult<Tensor> {
        // Check cache with explicit type hint for compiler
        if let Some(val) = self.values.get(target.0).and_then(|v: &Option<Tensor>| v.as_ref()) {
            return Ok(val.clone());
        }

        // Helper to check if node is leaf (Input/Param) and return its value if so
        let leaf_val = match self.nodes.get(target.0).ok_or_else(|| GPError::InferenceError(format!("Node not found: {:?}", target)))? {
            Node::Input(t) => Some(t.clone()),
            Node::Param(t) => Some(t.clone()),
            Node::Op { .. } => None,
        };

        if let Some(val) = leaf_val {
            if self.values.len() <= target.0 {
                self.values.resize(target.0 + 1, None);
            }
            self.values[target.0] = Some(val.clone());
            return Ok(val);
        }

        let inputs = match &self.nodes[target.0] {
            Node::Op { inputs, .. } => inputs.clone(),
            _ => unreachable!(),
        };

        let mut input_tensors = Vec::with_capacity(inputs.len());
        for &input_id in &inputs {
            input_tensors.push(self.execute(input_id)?);
        }

        let backend = self.backend.as_deref().ok_or(GPError::BackendNotInitialized)?;
        let val = if let Node::Op { op, .. } = &self.nodes[target.0] {
            op.forward(&input_tensors, backend)?
        } else {
            unreachable!()
        };

        if self.values.len() <= target.0 {
            self.values.resize(target.0 + 1, None);
        }
        self.values[target.0] = Some(val.clone());
        Ok(val)
    }

    /// Backward pass: Propagates gradients starting from the target node
    pub fn backward(&mut self, target: NodeId, grad_output: Tensor) -> GPResult<()> {
        if self.gradients.len() <= target.0 {
            self.gradients.resize(target.0 + 1, None);
        }

        // Accumulate gradient
        if let Some(existing_grad) = &self.gradients[target.0] {
            self.gradients[target.0] = Some(existing_grad + &grad_output);
        } else {
            self.gradients[target.0] = Some(grad_output.clone());
        }

        let inputs = match &self.nodes[target.0] {
            Node::Op { inputs, .. } => inputs.clone(),
            _ => return Ok(()),
        };

        let mut input_tensors = Vec::with_capacity(inputs.len());
        for &input_id in &inputs {
            input_tensors.push(self.values[input_id.0].as_ref()
                .ok_or_else(|| GPError::InferenceError(format!("Value not found for node {:?}", input_id)))?.clone());
        }

        let current_grad = self.gradients[target.0].as_ref().unwrap();
        let backend = self.backend.as_deref().ok_or(GPError::BackendNotInitialized)?;
        
        // Re-borrow op here
        let input_grads = if let Node::Op { op, .. } = &self.nodes[target.0] {
            op.backward(&input_tensors, current_grad, backend)?
        } else {
            unreachable!()
        };
        
        for (i, &input_id) in inputs.iter().enumerate() {
            self.backward(input_id, input_grads[i].clone())?;
        }
        Ok(())
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
        for v in &mut self.values {
            *v = None;
        }
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
