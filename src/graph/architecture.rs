//! Computation graph topology — structure without execution state.
//!
//! [`Architecture`] owns the directed acyclic graph (DAG) of nodes that define
//! a neural network's computation. It is purely structural: it knows about
//! node connections and topological ordering, but holds no execution cache,
//! backend reference, or gradient state.
//!
//! # Separation of Concerns
//!
//! | Component       | Responsibility                        |
//! |-----------------|---------------------------------------|
//! | `Architecture`  | DAG topology, node management, sort   |
//! | `ParamStore`    | Trainable parameter tensors + grads   |
//! | `Graph`         | Composes both + execution state       |
//!
//! # Design
//!
//! Once built, an `Architecture` can be:
//! - Serialized independently of execution state
//! - Shared between multiple execution contexts (read-only)
//! - Validated for shape consistency via the `Verifier`
//! - Inspected for visualization without a backend

use serde::{Serialize, Deserialize};
use crate::{GPError, GPResult, Tensor, NodeId};
use crate::params::ParamId;
use super::{Node, OpType};

/// The topology of a computation graph.
///
/// Holds the DAG of [`Node`]s (inputs, parameters, operations) and provides
/// topological sorting. Does not hold any execution state.
///
/// # Invariants
///
/// - Node indices are dense: `NodeId(i)` is valid iff `i < self.node_count()`.
/// - The graph is a DAG: `topological_sort` will detect cycles.
/// - `Node::Input` nodes hold a tensor that serves as the mutable input buffer.
/// - `Node::Param` nodes reference a [`ParamId`] in an external [`ParamStore`].
#[derive(Serialize, Deserialize)]
pub struct Architecture {
    nodes: Vec<Node>,
}

impl Architecture {
    /// Creates an empty architecture with no nodes.
    pub fn new() -> Self {
        Self { nodes: Vec::new() }
    }

    /// Returns the number of nodes in the graph.
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Returns true if the architecture has no nodes.
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    // ── Node Construction ──────────────────────────────────────────────────

    /// Adds an input node with the given tensor as its initial buffer.
    ///
    /// The tensor shape defines the expected input dimensions.
    /// The tensor data can be overwritten before each forward pass.
    pub fn input(&mut self, tensor: Tensor) -> NodeId {
        let id = NodeId(self.nodes.len());
        self.nodes.push(Node::Input(tensor));
        id
    }

    /// Adds a parameter node referencing a [`ParamId`] in a [`ParamStore`].
    pub fn param(&mut self, param_id: ParamId) -> NodeId {
        let id = NodeId(self.nodes.len());
        self.nodes.push(Node::Param(param_id));
        id
    }

    /// Adds an operation node with the given op type and input node IDs.
    pub fn op(&mut self, op: OpType, inputs: Vec<NodeId>) -> NodeId {
        let id = NodeId(self.nodes.len());
        self.nodes.push(Node::Op { op, inputs });
        id
    }

    // ── Node Access ────────────────────────────────────────────────────────

    /// Returns a slice of all nodes.
    pub fn nodes(&self) -> &[Node] {
        &self.nodes
    }

    /// Returns a mutable slice of all nodes.
    ///
    /// Primarily used for mutating `Node::Input` tensors before execution.
    pub fn nodes_mut(&mut self) -> &mut [Node] {
        &mut self.nodes
    }

    /// Returns a reference to a specific node, or `None` if out of bounds.
    pub fn get_node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(id.0)
    }

    // ── Topological Sort ───────────────────────────────────────────────────

    /// Computes the topological execution order for the subgraph rooted at `target`.
    ///
    /// Uses an iterative DFS (no recursion) to avoid stack overflow in WASM.
    /// Detects cycles and returns an error if one is found.
    ///
    /// # Returns
    ///
    /// A `Vec<NodeId>` in dependency order: nodes that must execute first
    /// appear earlier in the vector.
    pub fn topological_sort(&self, target: NodeId) -> GPResult<Vec<NodeId>> {
        let n = self.nodes.len();
        let mut order = Vec::new();
        let mut visited = vec![false; n];
        let mut on_stack = vec![false; n];
        let mut stack = vec![(target, false)];

        while let Some((id, processed)) = stack.pop() {
            if id.0 >= n {
                return Err(GPError::InferenceError(format!(
                    "Node index {} out of bounds (graph has {} nodes)", id.0, n
                )));
            }

            if processed {
                on_stack[id.0] = false;
                order.push(id);
                continue;
            }

            if visited[id.0] {
                continue;
            }

            if on_stack[id.0] {
                return Err(GPError::InferenceError(
                    "Cycle detected in computation graph".to_string()
                ));
            }

            visited[id.0] = true;
            on_stack[id.0] = true;
            stack.push((id, true));

            if let Node::Op { inputs, .. } = &self.nodes[id.0] {
                for &input_id in inputs.iter().rev() {
                    stack.push((input_id, false));
                }
            }
        }
        Ok(order)
    }

    // ── Query Methods ──────────────────────────────────────────────────────

    /// Returns the indices of all parameter nodes.
    pub fn param_node_ids(&self) -> Vec<(NodeId, ParamId)> {
        self.nodes.iter().enumerate()
            .filter_map(|(i, node)| {
                if let Node::Param(pid) = node {
                    Some((NodeId(i), *pid))
                } else {
                    None
                }
            })
            .collect()
    }

    /// Returns the indices of all input nodes.
    pub fn input_node_ids(&self) -> Vec<NodeId> {
        self.nodes.iter().enumerate()
            .filter_map(|(i, node)| {
                if matches!(node, Node::Input(_)) {
                    Some(NodeId(i))
                } else {
                    None
                }
            })
            .collect()
    }
}

impl Default for Architecture {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_architecture() {
        let arch = Architecture::new();
        assert_eq!(arch.node_count(), 0);
        assert!(arch.is_empty());
    }

    #[test]
    fn test_add_nodes() {
        let mut arch = Architecture::new();
        let input = arch.input(Tensor::new_zeros(&[1, 2]));
        let param = arch.param(ParamId(0));
        let out = arch.op(OpType::MatMul, vec![input, param]);

        assert_eq!(arch.node_count(), 3);
        assert_eq!(input, NodeId(0));
        assert_eq!(param, NodeId(1));
        assert_eq!(out, NodeId(2));
    }

    #[test]
    fn test_topological_sort_simple() {
        // input(0) → matmul(2) → relu(3)
        //            ↑
        // param(1) ──┘
        let mut arch = Architecture::new();
        let input = arch.input(Tensor::new_zeros(&[1, 2]));
        let param = arch.param(ParamId(0));
        let mm = arch.op(OpType::MatMul, vec![input, param]);
        let out = arch.op(OpType::ReLU, vec![mm]);

        let order = arch.topological_sort(out).unwrap();
        assert_eq!(order.len(), 4);
        // input and param must come before matmul, matmul before relu
        let mm_pos = order.iter().position(|&id| id == mm).unwrap();
        let out_pos = order.iter().position(|&id| id == out).unwrap();
        let input_pos = order.iter().position(|&id| id == input).unwrap();
        let param_pos = order.iter().position(|&id| id == param).unwrap();
        assert!(input_pos < mm_pos);
        assert!(param_pos < mm_pos);
        assert!(mm_pos < out_pos);
    }

    #[test]
    fn test_topological_sort_diamond() {
        // input(0) → relu(1) → add(3)
        //                ↑       ↑
        //          sigmoid(2) ───┘
        let mut arch = Architecture::new();
        let input = arch.input(Tensor::new_zeros(&[1, 2]));
        let relu = arch.op(OpType::ReLU, vec![input]);
        let sigmoid = arch.op(OpType::Sigmoid, vec![input]);
        let add = arch.op(OpType::Add, vec![relu, sigmoid]);

        let order = arch.topological_sort(add).unwrap();
        assert_eq!(order.len(), 4);
        let input_pos = order.iter().position(|&id| id == input).unwrap();
        let add_pos = order.iter().position(|&id| id == add).unwrap();
        assert!(input_pos < add_pos);
    }

    #[test]
    fn test_param_node_ids() {
        let mut arch = Architecture::new();
        arch.input(Tensor::new_zeros(&[1, 2]));
        arch.param(ParamId(0));
        arch.param(ParamId(1));
        arch.op(OpType::ReLU, vec![NodeId(0)]);

        let params = arch.param_node_ids();
        assert_eq!(params.len(), 2);
        assert_eq!(params[0], (NodeId(1), ParamId(0)));
        assert_eq!(params[1], (NodeId(2), ParamId(1)));
    }

    #[test]
    fn test_input_node_ids() {
        let mut arch = Architecture::new();
        arch.input(Tensor::new_zeros(&[1, 2]));
        arch.param(ParamId(0));
        arch.input(Tensor::new_zeros(&[1, 3]));

        let inputs = arch.input_node_ids();
        assert_eq!(inputs, vec![NodeId(0), NodeId(2)]);
    }

    #[test]
    fn test_serialization_roundtrip() {
        let mut arch = Architecture::new();
        arch.input(Tensor::new_zeros(&[1, 2]));
        arch.param(ParamId(0));
        arch.op(OpType::ReLU, vec![NodeId(0)]);

        let json = serde_json::to_string(&arch).unwrap();
        let restored: Architecture = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.node_count(), 3);
    }
}
