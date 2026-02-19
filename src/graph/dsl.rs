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

    pub fn conv2d(&mut self, input: NodeId, weight: NodeId, stride: usize, padding: usize) -> NodeId {
        self.graph.op(OpType::Conv2D { stride, padding }, vec![input, weight])
    }

    pub fn max_pool2d(&mut self, input: NodeId, kernel_size: usize, stride: usize) -> NodeId {
        self.graph.op(OpType::MaxPool2D { kernel_size, stride }, vec![input])
    }

    pub fn reshape(&mut self, input: NodeId, target_shape: Vec<usize>) -> NodeId {
        self.graph.op(OpType::Reshape { target_shape }, vec![input])
    }

    pub fn flatten(&mut self, input: NodeId) -> NodeId {
        // We assume index 0 is Batch. We flatten the rest. 
        // This is a common pattern for CNN -> Linear transition.
        // For real usage, we should probably check current shape, 
        // but since we compute shapes statically we can do it if we have access to it.
        // Here we'll just use a large target_shape or a placeholder that the Op handles.
        // Actually, let's make the Op handle -1 or similar? No, let's just make it explicit.
        // We'll calculate it in the example for now, or add a proper shape accessor.
        self.reshape(input, vec![0]) // Placeholder, we'll refine the Op or DSL to handle this.
    }
}
