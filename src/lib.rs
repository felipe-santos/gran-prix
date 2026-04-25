pub mod layers;
pub mod graph;
pub mod backend;
pub mod tensor;
pub mod errors;
pub mod types;
pub mod loss;
pub mod optim;
pub mod params;
pub mod network_def;
pub mod scheduler;

pub use tensor::Tensor;
pub use errors::{GPError, GPResult};
pub use types::{NodeId, Shape, Device};
pub use params::{ParamStore, ParamId};
pub use graph::{Architecture, ExecutionEngine};

/// Base trait for all neural network layers.
#[typetag::serde]
pub trait Layer: Send + Sync + std::fmt::Debug {
    fn forward(&mut self, input: NodeId, graph: &mut graph::dsl::GraphBuilder) -> NodeId;

    /// Optional method invoked after a graph forward pass to persist any internal state.
    /// Returns the node ID of the state tensor so it can be evaluated and saved.
    fn state_node(&self) -> Option<NodeId> { None }

    /// Updates the internal state with the evaluated tensor.
    fn update_state(&mut self, _tensor: Tensor) {}

    /// Resets the internal state (e.g. at the start of a new episode).
    fn reset_state(&mut self) {}

    /// Sets a name prefix used when this layer registers parameters in the
    /// underlying `ParamStore`. Implementors with trainable parameters
    /// should override this to record the prefix and use it inside
    /// [`forward`] via `graph.named_param(...)` so each parameter ends up
    /// registered as `"<prefix>.<role>"` (e.g., `"layers[3].weight"`).
    ///
    /// Default implementation is a no-op — appropriate for stateless
    /// layers (Activation, Dropout) that don't register parameters.
    ///
    /// Empty prefix (the default if [`forward`] is called without setting
    /// one) preserves the legacy behavior of registering parameters with
    /// empty names.
    fn set_name_prefix(&mut self, _prefix: String) {}
}

#[cfg(test)]
mod tests_math;
