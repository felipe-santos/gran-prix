use crate::{Layer, NodeId};
use crate::graph::dsl::GraphBuilder;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ActivationType {
    ReLU,
    Sigmoid,
    Tanh,
    Softmax,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Activation {
    pub activation_type: ActivationType,
}

impl Activation {
    pub fn new(activation_type: ActivationType) -> Self {
        Self { activation_type }
    }
}

#[typetag::serde]
impl Layer for Activation {
    fn forward(&mut self, input: NodeId, graph: &mut GraphBuilder) -> NodeId {
        match self.activation_type {
            ActivationType::ReLU => graph.relu(input),
            ActivationType::Sigmoid => graph.sigmoid(input),
            ActivationType::Tanh => graph.tanh(input),
            ActivationType::Softmax => graph.softmax(input),
        }
    }
}
