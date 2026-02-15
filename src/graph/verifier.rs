use crate::graph::{Graph, Node, NodeId};
use anyhow::{Result, anyhow};
use std::collections::HashMap;

/// Static Verifier for the Computation Graph.
pub struct Verifier;

impl Verifier {
    /// Validates the graph for shape consistency and connectivity.
    /// Returns a map of NodeId -> Predicted Shape.
    pub fn verify(graph: &Graph) -> Result<HashMap<NodeId, Vec<usize>>> {
        let mut predicted_shapes = HashMap::new();
        let nodes = graph.nodes();

        println!("[Verifier] Starting static analysis of {} nodes...", nodes.len());

        for (i, node) in nodes.iter().enumerate() {
            let id = NodeId(i);
            match node {
                Node::Input(tensor) | Node::Param(tensor) => {
                    predicted_shapes.insert(id, tensor.shape().to_vec());
                }
                Node::Op { op, inputs } => {
                    let mut input_shapes = Vec::new();
                    for &input_id in inputs {
                        let shape = predicted_shapes.get(&input_id)
                            .ok_or_else(|| anyhow!("Node {:?} uses input from future node {:?} (Connectivity error)", id, input_id))?;
                        input_shapes.push(shape.clone());
                    }

                    let output_shape = op.output_shape(&input_shapes)
                        .map_err(|e| anyhow!("Shape error at node {} ({}): {}", i, op.name(), e))?;
                    
                    predicted_shapes.insert(id, output_shape);
                }
            }
        }

        println!("[Verifier] Graph validated successfully. All shapes are consistent.");
        Ok(predicted_shapes)
    }
}
