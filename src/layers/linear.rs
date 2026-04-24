use crate::{Tensor, Layer, NodeId};
use crate::graph::dsl::GraphBuilder;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct Linear {
    pub weights: Tensor,
    pub biases: Tensor,
}

impl Linear {
    /// Creates a new Linear layer with Xavier-uniform initialization.
    ///
    /// Weights are initialized from `Uniform(-limit, limit)` where
    /// `limit = sqrt(6 / (input_dim + output_dim))` (Glorot/Xavier).
    /// This prevents activation saturation in Tanh/Sigmoid networks.
    pub fn new(input_dim: usize, output_dim: usize) -> Self {
        let mut weights = Tensor::new_random(&[input_dim, output_dim]);
        // Apply Xavier scaling: Uniform(-1,1) * sqrt(6/(in+out))
        let scale = (6.0 / (input_dim as f32 + output_dim as f32)).sqrt();
        weights.scale_inplace(scale).unwrap();
        let biases = Tensor::new_zeros(&[1, output_dim]);

        Self { weights, biases }
    }
}

#[typetag::serde]
impl Layer for Linear {
    fn forward(&mut self, input: NodeId, graph: &mut GraphBuilder) -> NodeId {
        let w = graph.param(self.weights.clone());
        let b = graph.param(self.biases.clone());
        graph.linear(input, w, b)
    }
}
