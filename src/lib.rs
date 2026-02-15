pub mod layers;
pub mod graph;
pub mod backend;
pub mod tensor;
pub mod errors;
pub mod types;
pub mod loss;

pub use tensor::{Tensor, TensorOps};
pub use errors::{GPError, GPResult};
pub use types::{NodeId, Shape, Device};

/// Base trait for all neural network layers.
#[typetag::serde]
pub trait Layer: Send + Sync + std::fmt::Debug {
    fn forward(&mut self, input: NodeId, graph: &mut graph::dsl::GraphBuilder) -> NodeId;
}
