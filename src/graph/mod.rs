pub mod dsl;
pub mod optimizer;
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

/// A generic operation in the DAG.
#[typetag::serde]
pub trait Operation: Send + Sync {
    fn name(&self) -> &str;
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> Result<Tensor>;
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> Result<Vec<Tensor>>;
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
}
