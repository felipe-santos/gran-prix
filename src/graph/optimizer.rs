use crate::graph::{Graph, Node};
use anyhow::Result;

/// Professional Optimizer for the Execution Graph.
pub struct GraphOptimizer;

#[derive(serde::Serialize, serde::Deserialize)]
pub struct AddReLUOp;
#[typetag::serde]
impl crate::graph::Operation for AddReLUOp {
    fn name(&self) -> &str { "AddReLU (Fused)" }
    fn forward(&self, inputs: &[crate::Tensor], backend: &dyn crate::backend::Backend) -> Result<crate::Tensor> {
        backend.add_relu(&inputs[0], &inputs[1])
    }
    fn backward(&self, inputs: &[crate::Tensor], grad_output: &crate::Tensor, backend: &dyn crate::backend::Backend) -> Result<Vec<crate::Tensor>> {
        let sum = backend.add(&inputs[0], &inputs[1])?;
        let mut grad = grad_output.clone();
        ndarray::Zip::from(&mut grad).and(&sum).for_each(|g, &s| {
            if s <= 0.0 { *g = 0.0; }
        });
        Ok(vec![grad.clone(), grad])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> Result<Vec<usize>> {
        Ok(input_shapes[0].clone())
    }
}

impl GraphOptimizer {
    /// Fuses operations to reduce memory bandwidth bottleneck.
    /// Detects patterns like Add -> ReLU and replaces them with a Fused kernel.
    pub fn optimize(graph: &mut Graph) {
        println!("[Optimizer] Running Kernel Fusion optimization...");
        
        // Simple 1-pass fusion logic
        for i in 0..graph.nodes.len() {
            if let Node::Op { op, inputs } = &graph.nodes[i] {
                if op.name() == "ReLU" {
                    let prev_node_id = inputs[0];
                    if let Node::Op { op: prev_op, inputs: prev_inputs } = &graph.nodes[prev_node_id.0] {
                        if prev_op.name() == "Add" {
                            println!("  >> Fusing Add(node {}) + ReLU(node {})", prev_node_id.0, i);
                            // Fusion: Re-map ReLU node to AddReLUOp using Add's inputs
                            let fused_inputs = prev_inputs.clone();
                            graph.nodes[i] = Node::Op {
                                op: Box::new(AddReLUOp),
                                inputs: fused_inputs,
                            };
                        }
                    }
                }
            }
        }
    }
}
