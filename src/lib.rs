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

    /// Sets a name prefix used when this layer registers parameters in
    /// the underlying `ParamStore`. Implementors with trainable
    /// parameters store the prefix and pass it through `graph.named_param`
    /// in [`forward`] so each parameter ends up registered as
    /// `"<prefix>.<role>"` (e.g., `"layers[3].weight"`).
    ///
    /// Stateless layers (Activation, etc.) implement this as an explicit
    /// no-op rather than relying on a default — making the implementor
    /// affirm that the layer has no parameters to name. This catches the
    /// case where a future layer adds parameters and forgets the naming.
    ///
    /// Empty prefix preserves direct graph-building behavior by registering
    /// parameters with empty names — used when a layer is built outside
    /// of `NetworkDef::compile`.
    fn set_name_prefix(&mut self, prefix: String);

    /// Returns the [`NodeId`] of the graph input node that holds this
    /// layer's *previous* recurrent state, if any.
    ///
    /// Recurrent layers (RNN, GRU) inject the previous hidden state
    /// into the graph as an `Input` node during [`forward`]. The
    /// computation produces a new hidden state at the [`state_node`]
    /// position, and a recurrence-aware caller is expected to copy
    /// that new value into the previous-state input node between
    /// forwards. Returning the previous-state node id is what makes
    /// that copy possible.
    ///
    /// Stateless layers (Activation, Linear, BatchNorm, Dropout)
    /// implement this as `None` explicitly rather than relying on a
    /// default — same rationale as [`set_name_prefix`]. A future
    /// stateful layer that forgets to override would silently
    /// regress recurrent-state handling; making the method required
    /// catches that at the trait-impl level.
    fn prev_state_input(&self) -> Option<NodeId>;
}

#[cfg(test)]
mod tests_math;
