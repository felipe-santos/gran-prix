pub mod dsl;
pub mod optimizer;
pub mod memory_planner;
pub mod verifier;
pub mod buffer_pool;
use crate::backend::Backend;
use crate::Tensor;
use anyhow::Result;
use serde::{Serialize, Deserialize};

/// Unique identifier for a node in the graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NodeId(pub usize);

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
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> Result<Tensor>;
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> Result<Vec<Tensor>>;
    
    /// Static shape inference: Determines output shape without computing values.
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> Result<Vec<usize>>;
}

// --- Concrete Operations ---

#[derive(Serialize, Deserialize)]
pub struct MatMul;
#[typetag::serde]
impl Operation for MatMul {
    fn name(&self) -> &str { "MatMul" }
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> Result<Tensor> {
        backend.matmul_t(&inputs[0], &inputs[1], false, false)
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> Result<Vec<Tensor>> {
        // grad_A = grad_output * B^T
        let grad_a = backend.matmul_t(grad_output, &inputs[1], false, true)?;
        // grad_B = A^T * grad_output
        let grad_b = backend.matmul_t(&inputs[0], grad_output, true, false)?;
        Ok(vec![grad_a, grad_b])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> Result<Vec<usize>> {
        if input_shapes[0][1] != input_shapes[1][0] {
            return Err(anyhow::anyhow!("Shape mismatch in MatMul: {:?} and {:?}", input_shapes[0], input_shapes[1]));
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
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> Result<Tensor> {
        backend.conv2d(&inputs[0], &inputs[1], self.stride, self.padding)
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> Result<Vec<Tensor>> {
        let (grad_input, grad_weight) = backend.conv2d_backward(&inputs[0], &inputs[1], grad_output, self.stride, self.padding)?;
        Ok(vec![grad_input, grad_weight])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> Result<Vec<usize>> {
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
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> Result<Tensor> {
        backend.max_pool2d(&inputs[0], self.kernel_size, self.stride)
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> Result<Vec<Tensor>> {
        let grad_input = backend.max_pool2d_backward(&inputs[0], grad_output, self.kernel_size, self.stride)?;
        Ok(vec![grad_input])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> Result<Vec<usize>> {
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
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> Result<Tensor> {
        backend.add(&inputs[0], &inputs[1])
    }
    fn backward(&self, _inputs: &[Tensor], grad_output: &Tensor, _backend: &dyn Backend) -> Result<Vec<Tensor>> {
        // Identity for both inputs
        Ok(vec![grad_output.clone(), grad_output.clone()])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> Result<Vec<usize>> {
        // Element-wise or broadcast: assuming shapes match for now
        Ok(input_shapes[0].clone())
    }
}

#[derive(Serialize, Deserialize)]
pub struct ReLUOp;
#[typetag::serde]
impl Operation for ReLUOp {
    fn name(&self) -> &str { "ReLU" }
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> Result<Tensor> {
        backend.relu(&inputs[0])
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, _backend: &dyn Backend) -> Result<Vec<Tensor>> {
        let mut grad = grad_output.clone();
        ndarray::Zip::from(&mut grad).and(&inputs[0]).for_each(|g, &i| {
            if i <= 0.0 { *g = 0.0; }
        });
        Ok(vec![grad])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> Result<Vec<usize>> {
        Ok(input_shapes[0].clone())
    }
}

#[derive(Serialize, Deserialize)]
pub struct SigmoidOp;
#[typetag::serde]
impl Operation for SigmoidOp {
    fn name(&self) -> &str { "Sigmoid" }
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> Result<Tensor> {
        backend.sigmoid(&inputs[0])
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> Result<Vec<Tensor>> {
        let s = backend.sigmoid(&inputs[0])?;
        let mut grad = grad_output.clone();
        ndarray::Zip::from(&mut grad).and(&s).for_each(|g, &si| {
            *g *= si * (1.0 - si);
        });
        Ok(vec![grad])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> Result<Vec<usize>> {
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
    fn forward(&self, inputs: &[Tensor], _backend: &dyn Backend) -> Result<Tensor> {
        let mut t = inputs[0].clone();
        t = t.into_shape(self.target_shape.as_slice())?.into_dyn();
        Ok(t)
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, _backend: &dyn Backend) -> Result<Vec<Tensor>> {
        let original_shape = inputs[0].shape();
        let mut grad = grad_output.clone();
        grad = grad.into_shape(original_shape)?.into_dyn();
        Ok(vec![grad])
    }
    fn output_shape(&self, _input_shapes: &[Vec<usize>]) -> Result<Vec<usize>> {
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
    #[tracing::instrument(skip(self), name = "graph_execute")]
    pub fn execute(&mut self, target: NodeId) -> Result<Tensor> {
        if let Some(val) = &self.values[target.0] {
            return Ok(val.clone());
        }

        // Clone node data to avoid borrow conflict
        let node_data = match &self.nodes[target.0] {
            Node::Input(t) | Node::Param(t) => return {
                self.values[target.0] = Some(t.clone());
                Ok(t.clone())
            },
            Node::Op { op, inputs } => (op.name().to_string(), inputs.clone()),
        };

        let mut input_tensors = Vec::new();
        for &input_id in &node_data.1 {
            input_tensors.push(self.execute(input_id)?);
        }

        let backend = self.backend.as_ref().ok_or_else(|| anyhow::anyhow!("Backend not initialized"))?;

        // Re-borrow the operation (this is safe now)
        let val = if let Node::Op { op, .. } = &self.nodes[target.0] {
            op.forward(&input_tensors, backend.as_ref())?
        } else {
            unreachable!()
        };

        self.values[target.0] = Some(val.clone());
        Ok(val)
    }

    /// Backward pass: Propagates gradients starting from the target node
    #[tracing::instrument(skip(self, grad_output), name = "graph_backward")]
    pub fn backward(&mut self, target: NodeId, grad_output: Tensor) -> Result<()> {
        // Reset gradients
        for g in &mut self.gradients {
            *g = None;
        }

        self.gradients[target.0] = Some(grad_output);

        // Traverse nodes in reverse order (assuming they were added in topological order)
        // For a true DAG we'd need a topological sort, but for most models construction order works.
        let backend = self.backend.as_ref().ok_or_else(|| anyhow::anyhow!("Backend not initialized"))?;

        for i in (0..self.nodes.len()).rev() {
            if let Some(grad) = self.gradients[i].clone() {
                if let Node::Op { op, inputs } = &self.nodes[i] {
                    let mut input_tensors = Vec::new();
                    for &input_id in inputs {
                        input_tensors.push(self.values[input_id.0].as_ref().unwrap().clone());
                    }

                    let input_grads = op.backward(&input_tensors, &grad, backend.as_ref())?;

                    for (j, &input_id) in inputs.iter().enumerate() {
                        let g = &input_grads[j];
                        match &mut self.gradients[input_id.0] {
                            Some(existing) => *existing += g,
                            None => self.gradients[input_id.0] = Some(g.clone()),
                        }
                    }
                }
            }
        }
        Ok(())
    }

    pub fn get_gradient(&self, id: NodeId) -> Option<&Tensor> {
        self.gradients.get(id.0).and_then(|g| g.as_ref())
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

    /// Mutates parameters based on gradients and a learning rate.
    /// This is a basic form of SGD implementation.
    pub fn update_parameters(&mut self, learning_rate: f32) -> Result<()> {
        for i in 0..self.nodes.len() {
            if let Some(grad) = &self.gradients[i] {
                if let Node::Param(ref mut param) = &mut self.nodes[i] {
                    // param = param - lr * grad
                    *param = (param.view().to_owned() - (grad * learning_rate)).into_dyn();
                }
            }
        }
        Ok(())
    }
}
