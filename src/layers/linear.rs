use crate::{Tensor, Layer, NodeId};
use crate::tensor::TensorOps;
use crate::graph::dsl::GraphBuilder;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct Linear {
    pub weights: Tensor,
    pub biases: Tensor,
}

impl Linear {
    pub fn new(input_dim: usize, output_dim: usize) -> Self {
        // Use standard initialization (He or Xavier would be better, but standard normal for now)
        let weights = Tensor::new_random(&[input_dim, output_dim]);
        let biases = Tensor::new_zeros(&[1, output_dim]);

        Self {
            weights,
            biases,
        }
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
