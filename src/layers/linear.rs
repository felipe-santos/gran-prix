use crate::{Tensor, Layer, NodeId};
use crate::graph::dsl::GraphBuilder;
use crate::layers::make_param_name;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct Linear {
    pub weights: Tensor,
    pub biases: Tensor,
    /// Optional prefix used when registering parameters. Set by
    /// `NetworkDef::compile` to e.g. `"layers[3]"` so that the parameters
    /// land in `ParamStore` as `"layers[3].weight"` and `"layers[3].bias"`.
    /// Default empty preserves legacy behavior for direct `Linear::new`
    /// users that don't go through `NetworkDef`.
    #[serde(default)]
    pub name_prefix: String,
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

        Self { weights, biases, name_prefix: String::new() }
    }
}

#[typetag::serde]
impl Layer for Linear {
    fn forward(&mut self, input: NodeId, graph: &mut GraphBuilder) -> NodeId {
        let w = graph.named_param(self.weights.clone(), &make_param_name(&self.name_prefix, "weight"));
        let b = graph.named_param(self.biases.clone(), &make_param_name(&self.name_prefix, "bias"));
        graph.linear(input, w, b)
    }

    fn set_name_prefix(&mut self, prefix: String) {
        self.name_prefix = prefix;
    }

    fn prev_state_input(&self) -> Option<NodeId> {
        // Linear has no recurrent state.
        None
    }
}
