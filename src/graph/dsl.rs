use crate::graph::{Graph, OpType};
use crate::{Tensor, NodeId};

pub struct GraphBuilder<'a> {
    graph: &'a mut Graph,
}

impl<'a> GraphBuilder<'a> {
    pub fn new(graph: &'a mut Graph) -> Self {
        Self { graph }
    }

    pub fn val(&mut self, tensor: Tensor) -> NodeId {
        self.graph.input(tensor)
    }

    pub fn param(&mut self, tensor: Tensor) -> NodeId {
        self.graph.param(tensor)
    }

    pub fn matmul(&mut self, a: NodeId, b: NodeId) -> NodeId {
        self.graph.op(OpType::MatMul, vec![a, b])
    }

    pub fn add(&mut self, a: NodeId, b: NodeId) -> NodeId {
        self.graph.op(OpType::Add, vec![a, b])
    }

    pub fn mul(&mut self, a: NodeId, b: NodeId) -> NodeId {
        self.graph.op(OpType::Mul, vec![a, b])
    }
    
    pub fn node(&mut self, op: OpType, inputs: Vec<NodeId>) -> NodeId {
        self.graph.op(op, inputs)
    }
    
    /// Professional helper for Linear transformation: XW + B
    pub fn linear(&mut self, x: NodeId, w: NodeId, b: NodeId) -> NodeId {
        let xw = self.matmul(x, w);
        self.add(xw, b)
    }

    pub fn relu(&mut self, x: NodeId) -> NodeId {
        self.graph.op(OpType::ReLU, vec![x])
    }

    pub fn tanh(&mut self, x: NodeId) -> NodeId {
        self.graph.op(OpType::Tanh, vec![x])
    }

    pub fn sigmoid(&mut self, input: NodeId) -> NodeId {
        self.graph.op(OpType::Sigmoid, vec![input])
    }

    pub fn softmax(&mut self, input: NodeId) -> NodeId {
        self.graph.op(OpType::Softmax, vec![input])
    }

    pub fn conv2d(&mut self, input: NodeId, weight: NodeId, stride: usize, padding: usize) -> NodeId {
        self.graph.op(OpType::Conv2D { stride, padding }, vec![input, weight])
    }

    pub fn max_pool2d(&mut self, input: NodeId, kernel_size: usize, stride: usize) -> NodeId {
        self.graph.op(OpType::MaxPool2D { kernel_size, stride }, vec![input])
    }

    pub fn reshape(&mut self, input: NodeId, target_shape: Vec<usize>) -> NodeId {
        self.graph.op(OpType::Reshape { target_shape }, vec![input])
    }

    /// Flattens a tensor to 2D: `[batch, features]`.
    ///
    /// Requires knowing the total feature count (product of all dims except batch).
    /// Use this after Conv2D/MaxPool2D layers to transition to Linear layers.
    ///
    /// # Example
    /// ```ignore
    /// // After conv producing shape [batch, channels, height, width]:
    /// let flat = gb.flatten(conv_output, channels * height * width);
    /// ```
    pub fn flatten(&mut self, input: NodeId, feature_count: usize) -> NodeId {
        self.reshape(input, vec![1, feature_count])
    }
}
