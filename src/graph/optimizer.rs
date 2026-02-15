use crate::graph::{Graph, Node, OpType};
use crate::GPResult;

pub struct GraphOptimizer;

impl GraphOptimizer {
    /// Fuses operations to reduce memory bandwidth bottleneck.
    /// Detects patterns like Add -> ReLU and replaces them with a Fused kernel.
    pub fn optimize(graph: &mut Graph) -> GPResult<()> {
        println!("[Optimizer] Running Kernel Fusion optimization...");
        
        let mut i = 0;
        while i < graph.nodes_mut().len() {
            // We need to be careful with indexing if we were to delete nodes, 
            // but here we only modify the current node.
            let nodes = graph.nodes_mut();
            if let Node::Op { op, inputs } = &nodes[i] {
                if let OpType::ReLU = op {
                    let prev_node_id = inputs[0];
                    if let Node::Op { op: prev_op, inputs: prev_inputs } = &nodes[prev_node_id.0] {
                        if let OpType::Add = prev_op {
                            println!("  >> Fusing Add(node {}) + ReLU(node {})", prev_node_id.0, i);
                            let fused_inputs = prev_inputs.clone();
                            nodes[i] = Node::Op {
                                op: OpType::AddReLU,
                                inputs: fused_inputs,
                            };
                        }
                    }
                }
            }
            i += 1;
        }
        Ok(())
    }
}
