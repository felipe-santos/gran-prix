use crate::graph::{Graph, NodeId, MatMul, Add, ReLUOp, SigmoidOp, Conv2D, MaxPool2D};
use crate::Tensor;

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
        self.graph.op(Box::new(MatMul), vec![a, b])
    }

    pub fn add(&mut self, a: NodeId, b: NodeId) -> NodeId {
        self.graph.op(Box::new(Add), vec![a, b])
    }
    
    /// Professional helper for Linear transformation: XW + B
    pub fn linear(&mut self, x: NodeId, w: NodeId, b: NodeId) -> NodeId {
        let xw = self.matmul(x, w);
        self.add(xw, b)
    }

    pub fn relu(&mut self, x: NodeId) -> NodeId {
        self.graph.op(Box::new(ReLUOp), vec![x])
    }

    pub fn sigmoid(&mut self, input: NodeId) -> NodeId {
        self.graph.op(Box::new(SigmoidOp), vec![input])
    }

    pub fn conv2d(&mut self, input: NodeId, weight: NodeId, stride: usize, padding: usize) -> NodeId {
        self.graph.op(Box::new(Conv2D { stride, padding }), vec![input, weight])
    }

    pub fn max_pool2d(&mut self, input: NodeId, kernel_size: usize, stride: usize) -> NodeId {
        self.graph.op(Box::new(MaxPool2D { kernel_size, stride }), vec![input])
    }
}
