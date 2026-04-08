use crate::graph::{Graph, Node};
use crate::{GPResult, GPError, NodeId};
use std::collections::HashMap;

/// Static shape verifier for computation graphs.
///
/// Walks the graph in topological order and computes predicted output shapes
/// for every node. Returns an error if any shape mismatch is detected.
pub struct Verifier;

impl Verifier {
    /// Validates the graph for shape consistency and connectivity.
    ///
    /// Returns a map of `NodeId → predicted shape` for every node in the graph.
    pub fn verify(graph: &Graph) -> GPResult<HashMap<NodeId, Vec<usize>>> {
        let mut predicted_shapes = HashMap::new();
        let nodes = graph.nodes();

        for (i, node) in nodes.iter().enumerate() {
            let id = NodeId(i);
            match node {
                Node::Input(tensor) => {
                    predicted_shapes.insert(id, tensor.shape().to_vec());
                }
                Node::Param(param_id) => {
                    let tensor = graph.params().tensor(*param_id);
                    predicted_shapes.insert(id, tensor.shape().to_vec());
                }
                Node::Op { op, inputs } => {
                    let mut input_shapes = Vec::new();
                    for &input_id in inputs {
                        let shape = predicted_shapes.get(&input_id)
                            .ok_or_else(|| GPError::InferenceError(format!(
                                "Node {:?} references missing or future node {:?}", id, input_id
                            )))?;
                        input_shapes.push(shape.clone());
                    }

                    let output_shape = op.output_shape(&input_shapes)
                        .map_err(|e| GPError::InferenceError(format!(
                            "Shape error at node {} ({}): {}", i, op.name(), e
                        )))?;

                    predicted_shapes.insert(id, output_shape);
                }
            }
        }

        Ok(predicted_shapes)
    }
}
