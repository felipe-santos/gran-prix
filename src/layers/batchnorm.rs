//! Batch Normalization layer.
//!
//! Normalizes inputs per-feature across the batch dimension, then applies
//! a learnable affine transform: `output = gamma * normalized + beta`.
//!
//! Implemented as a dedicated `OpType::BatchNorm` that computes batch
//! statistics (mean, variance) inline during the forward pass.

use crate::{Tensor, Layer, NodeId};
use crate::graph::dsl::GraphBuilder;
use crate::graph::OpType;
use serde::{Serialize, Deserialize};

/// Batch Normalization: `y = gamma * (x - mean) / sqrt(var + eps) + beta`.
///
/// - `gamma` (scale) and `beta` (shift) are learnable parameters.
/// - Statistics are computed per-feature across the batch dimension.
/// - Backward pass computes gradients for gamma, beta, and input correctly.
///
/// # Shape
///
/// Input: `[batch, features]` → Output: `[batch, features]`
#[derive(Serialize, Deserialize, Debug)]
pub struct BatchNorm {
    pub num_features: usize,
    pub epsilon: f32,
    pub gamma: Tensor,
    pub beta: Tensor,
}

impl BatchNorm {
    pub fn new(num_features: usize) -> Self {
        Self {
            num_features,
            epsilon: 1e-5,
            gamma: Tensor::new_ones(&[1, num_features]),
            beta: Tensor::new_zeros(&[1, num_features]),
        }
    }
}

#[typetag::serde]
impl Layer for BatchNorm {
    fn forward(&mut self, input: NodeId, graph: &mut GraphBuilder) -> NodeId {
        let gamma_node = graph.param(self.gamma.clone());
        let beta_node = graph.param(self.beta.clone());

        // Use the dedicated BatchNorm op that handles normalization internally.
        // The op takes 3 inputs: [input, gamma, beta] and the epsilon is
        // stored in the OpType variant.
        graph.node(
            OpType::BatchNorm { epsilon: self.epsilon },
            vec![input, gamma_node, beta_node],
        )
    }
}
