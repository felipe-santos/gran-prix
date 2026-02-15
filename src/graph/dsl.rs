use crate::graph::{Graph, NodeId, MatMul, Add, ReLUOp, SigmoidOp};
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

    pub fn sigmoid(&mut self, x: NodeId) -> NodeId {
        self.graph.op(Box::new(SigmoidOp), vec![x])
    }
}
