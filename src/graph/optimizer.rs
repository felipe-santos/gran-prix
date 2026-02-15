use crate::graph::{Graph, Node};
use crate::backend::Backend;
use crate::{GPResult, Tensor};
use crate::tensor::TensorOps;
use serde::{Serialize, Deserialize};

/// Professional Optimizer for the Execution Graph.
pub struct GraphOptimizer;

#[derive(Serialize, Deserialize)]
pub struct AddReLUOp;

#[typetag::serde]
impl crate::graph::Operation for AddReLUOp {
    fn name(&self) -> &str { "AddReLU (Fused)" }
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> GPResult<Tensor> {
        backend.add_relu(&inputs[0], &inputs[1])
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        let grad = grad_output.clone();
        
        // For CPU, we can perform this optimization. For CUDA, the backend should ideally handle fused backward too.
        // For now, let's keep it simple and safe.
        let mask = backend.relu_backward(&inputs[0], &grad)?; // Assuming 'ones' was a placeholder for 'grad' or similar context
        // Use mask to zero out gradients where input < 0
        let grad_masked = backend.add(&Tensor::new_zeros(mask.shape()), &(&grad * &mask))?;
        Ok(vec![grad_masked.clone(), grad_masked])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        Ok(input_shapes[0].clone())
    }
}

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
                if op.name() == "ReLU" {
                    let prev_node_id = inputs[0];
                    if let Node::Op { op: prev_op, inputs: prev_inputs } = &nodes[prev_node_id.0] {
                        if prev_op.name() == "Add" {
                            println!("  >> Fusing Add(node {}) + ReLU(node {})", prev_node_id.0, i);
                            let fused_inputs = prev_inputs.clone();
                            nodes[i] = Node::Op {
                                op: Box::new(AddReLUOp),
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
