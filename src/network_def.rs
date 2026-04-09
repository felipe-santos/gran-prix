//! Declarative neural network definitions.
//!
//! [`NetworkDef`] describes a network architecture as a list of [`LayerDef`]s
//! and connections between them. It is purely declarative — no tensors are
//! allocated, no graph is built. This enables:
//!
//! - **Serialization**: Save/load architectures as JSON before training
//! - **Validation**: Check for errors (missing connections, size mismatches)
//!   before allocating any memory
//! - **Compilation**: Convert to a live [`Graph`] with [`compile()`]
//! - **Sharing**: The same definition can produce multiple independent graphs
//!
//! # Relationship to existing types
//!
//! | Type          | Role                                      |
//! |---------------|-------------------------------------------|
//! | `NetworkDef`  | Describes *what* the network looks like    |
//! | `Graph`       | A live, executable computation graph       |
//! | `Layer` trait | Imperative graph-building (still works)    |
//!
//! `NetworkDef` replaces the ad-hoc `WasmArchitecture` JSON format in the
//! WASM bridge with a canonical, core-level representation.

use serde::{Serialize, Deserialize};
use crate::{GPError, GPResult, Tensor};
use crate::layers::{Linear, Activation, RNNCell, GRUCell, BatchNorm};

// Re-export ActivationType as the canonical activation enum for this module.
pub use crate::layers::ActivationType;
use crate::graph::{Graph, dsl::GraphBuilder};
use crate::backend::Backend;
use crate::Layer;

// ── Layer Definition ───────────────────────────────────────────────────────

/// Describes a single layer's type and hyperparameters.
///
/// This is a pure data description — no tensors, no graph nodes.
/// Weights are allocated during [`NetworkDef::compile()`].
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum LayerDef {
    /// Fully connected layer: `output = input @ W + b`
    Linear {
        in_features: usize,
        out_features: usize,
    },
    /// Activation function applied element-wise.
    Activation {
        #[serde(rename = "function")]
        function: ActivationType,
    },
    /// Simple recurrent cell: `h_t = tanh(W_ih * x + W_hh * h_{t-1} + b)`
    Rnn {
        input_size: usize,
        hidden_size: usize,
    },
    /// Gated Recurrent Unit: update/reset/new gates with temporal memory.
    Gru {
        input_size: usize,
        hidden_size: usize,
    },
    /// Dropout: zeroes random elements during training (identity during inference).
    Dropout {
        rate: f32,
    },
    /// Batch Normalization: learnable affine transform per feature.
    BatchNorm {
        num_features: usize,
    },
}

impl LayerDef {
    /// Returns the output dimension of this layer given the input dimension.
    ///
    /// For layers that don't change dimension (e.g., Activation), returns `input_dim`.
    pub fn output_dim(&self, input_dim: usize) -> usize {
        match self {
            LayerDef::Linear { out_features, .. } => *out_features,
            LayerDef::Activation { .. } | LayerDef::Dropout { .. } | LayerDef::BatchNorm { .. } => input_dim,
            LayerDef::Rnn { hidden_size, .. } => *hidden_size,
            LayerDef::Gru { hidden_size, .. } => *hidden_size,
        }
    }

    /// Returns the expected input dimension, if constrained by the layer type.
    pub fn expected_input_dim(&self) -> Option<usize> {
        match self {
            LayerDef::Linear { in_features, .. } => Some(*in_features),
            LayerDef::Rnn { input_size, .. } => Some(*input_size),
            LayerDef::Gru { input_size, .. } => Some(*input_size),
            LayerDef::Activation { .. } | LayerDef::Dropout { .. } | LayerDef::BatchNorm { .. } => None,
        }
    }
}

// ── Network Definition ─────────────────────────────────────────────────────

/// A declarative, serializable description of a neural network.
///
/// Describes a sequential stack of layers from input to output.
/// Can be validated and compiled into a live [`Graph`].
///
/// # Example
///
/// ```rust
/// use gran_prix::network_def::{NetworkDef, LayerDef, ActivationType};
///
/// let net = NetworkDef::new(2, vec![
///     LayerDef::Linear { in_features: 2, out_features: 8 },
///     LayerDef::Activation { function: ActivationType::ReLU },
///     LayerDef::Linear { in_features: 8, out_features: 1 },
///     LayerDef::Activation { function: ActivationType::Sigmoid },
/// ]);
///
/// assert!(net.validate().is_ok());
/// ```
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NetworkDef {
    /// Number of input features.
    pub input_dim: usize,
    /// Sequential list of layers from input to output.
    pub layers: Vec<LayerDef>,
}

impl NetworkDef {
    /// Creates a new network definition.
    pub fn new(input_dim: usize, layers: Vec<LayerDef>) -> Self {
        Self { input_dim, layers }
    }

    /// Returns the output dimension of the network.
    pub fn output_dim(&self) -> usize {
        let mut dim = self.input_dim;
        for layer in &self.layers {
            dim = layer.output_dim(dim);
        }
        dim
    }

    /// Returns the total number of layers.
    pub fn layer_count(&self) -> usize {
        self.layers.len()
    }

    /// Validates the network definition for consistency.
    ///
    /// Checks:
    /// - At least one layer exists
    /// - Input dimensions chain correctly through all layers
    /// - No zero-dimensional layers
    pub fn validate(&self) -> GPResult<()> {
        if self.input_dim == 0 {
            return Err(GPError::InferenceError(
                "NetworkDef: input_dim must be > 0".to_string()
            ));
        }
        if self.layers.is_empty() {
            return Err(GPError::InferenceError(
                "NetworkDef: must have at least one layer".to_string()
            ));
        }

        let mut current_dim = self.input_dim;
        for (i, layer) in self.layers.iter().enumerate() {
            // Check that the layer's expected input matches the current flow
            if let Some(expected) = layer.expected_input_dim() {
                if expected != current_dim {
                    return Err(GPError::InferenceError(format!(
                        "NetworkDef: layer {} expects input_dim={}, but previous output is {}",
                        i, expected, current_dim
                    )));
                }
            }

            let out = layer.output_dim(current_dim);
            if out == 0 {
                return Err(GPError::InferenceError(format!(
                    "NetworkDef: layer {} has zero output dimension", i
                )));
            }
            current_dim = out;
        }

        Ok(())
    }

    /// Compiles this definition into a live [`Graph`] with allocated weights.
    ///
    /// Each layer's parameters are initialized (random for weights, zeros for biases)
    /// and registered in the graph's [`ParamStore`].
    ///
    /// # Returns
    ///
    /// A tuple of `(Graph, input_node_id, output_node_id)` ready for execution.
    ///
    /// # Errors
    ///
    /// Returns an error if validation fails.
    pub fn compile(&self, backend: Box<dyn Backend>) -> GPResult<CompiledNetwork> {
        self.validate()?;

        let mut graph = Graph::new(backend);
        let input_tensor = Tensor::new_zeros(&[1, self.input_dim]);
        let input_id = graph.input(input_tensor);

        let mut gb = GraphBuilder::new(&mut graph);
        let mut last_node = input_id;
        let mut stateful_layers: Vec<Box<dyn Layer>> = Vec::new();

        for layer_def in &self.layers {
            match layer_def {
                LayerDef::Linear { in_features, out_features } => {
                    let mut linear = Linear::new(*in_features, *out_features);
                    last_node = linear.forward(last_node, &mut gb);
                }
                LayerDef::Activation { function } => {
                    let mut act = Activation::new(function.clone());
                    last_node = act.forward(last_node, &mut gb);
                }
                LayerDef::Rnn { input_size, hidden_size } => {
                    let mut rnn = RNNCell::new(*input_size, *hidden_size);
                    last_node = rnn.forward(last_node, &mut gb);
                    stateful_layers.push(Box::new(rnn));
                }
                LayerDef::Gru { input_size, hidden_size } => {
                    let mut gru = GRUCell::new(*input_size, *hidden_size);
                    last_node = gru.forward(last_node, &mut gb);
                    stateful_layers.push(Box::new(gru));
                }
                LayerDef::Dropout { rate } => {
                    last_node = gb.dropout(last_node, *rate);
                }
                LayerDef::BatchNorm { num_features } => {
                    let mut bn = BatchNorm::new(*num_features);
                    last_node = bn.forward(last_node, &mut gb);
                }
            }
        }

        Ok(CompiledNetwork {
            graph,
            input_node: input_id,
            output_node: last_node,
            stateful_layers,
        })
    }

    /// Serializes this definition to a JSON string.
    pub fn to_json(&self) -> GPResult<String> {
        serde_json::to_string_pretty(self)
            .map_err(|e| GPError::SerializationError(e.to_string()))
    }

    /// Deserializes a definition from a JSON string.
    pub fn from_json(json: &str) -> GPResult<Self> {
        serde_json::from_str(json)
            .map_err(|e| GPError::SerializationError(e.to_string()))
    }
}

// ── Compiled Network ───────────────────────────────────────────────────────

/// A compiled network — a [`Graph`] with tracked input/output nodes
/// and stateful layers (RNN/GRU) that need state management.
pub struct CompiledNetwork {
    /// The live computation graph.
    pub graph: Graph,
    /// The input node ID (where to inject data).
    pub input_node: crate::NodeId,
    /// The output node ID (where to read predictions).
    pub output_node: crate::NodeId,
    /// Layers with internal state (RNN, GRU) that need update/reset.
    pub stateful_layers: Vec<Box<dyn Layer>>,
}

impl CompiledNetwork {
    /// Updates stateful layers (RNN/GRU) after a forward pass.
    ///
    /// Reads the state node's computed value from the graph and
    /// writes it back into the layer's hidden state.
    pub fn update_states(&mut self) {
        for layer in &mut self.stateful_layers {
            if let Some(state_node_id) = layer.state_node() {
                if let Some(Some(tensor)) = self.graph.values().get(state_node_id.0) {
                    layer.update_state(tensor.clone());
                }
            }
        }
    }

    /// Resets all stateful layers (e.g., at the start of a new episode).
    pub fn reset_states(&mut self) {
        for layer in &mut self.stateful_layers {
            layer.reset_state();
        }
    }
}

// ── Convenience Builders ───────────────────────────────────────────────────

impl NetworkDef {
    /// Creates a simple feedforward MLP definition.
    ///
    /// # Arguments
    ///
    /// * `input_dim` - Number of input features
    /// * `hidden_sizes` - Sizes of hidden layers
    /// * `output_dim` - Number of output features
    /// * `hidden_activation` - Activation for hidden layers
    /// * `output_activation` - Optional activation for the output layer
    ///
    /// # Example
    ///
    /// ```rust
    /// use gran_prix::network_def::{NetworkDef, ActivationType};
    ///
    /// let net = NetworkDef::mlp(2, &[8, 4], 1, ActivationType::ReLU, Some(ActivationType::Sigmoid));
    /// assert_eq!(net.output_dim(), 1);
    /// assert_eq!(net.layer_count(), 6); // 2×(Linear+Act) + Linear + Act = 6
    /// ```
    pub fn mlp(
        input_dim: usize,
        hidden_sizes: &[usize],
        output_dim: usize,
        hidden_activation: ActivationType,
        output_activation: Option<ActivationType>,
    ) -> Self {
        let mut layers = Vec::new();
        let mut current = input_dim;

        for &hidden in hidden_sizes {
            layers.push(LayerDef::Linear { in_features: current, out_features: hidden });
            layers.push(LayerDef::Activation { function: hidden_activation.clone() });
            current = hidden;
        }

        layers.push(LayerDef::Linear { in_features: current, out_features: output_dim });
        if let Some(act) = output_activation {
            layers.push(LayerDef::Activation { function: act });
        }

        Self::new(input_dim, layers)
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::cpu::CPUBackend;

    #[test]
    fn test_mlp_builder() {
        let net = NetworkDef::mlp(
            4, &[8, 4], 2,
            ActivationType::ReLU,
            Some(ActivationType::Sigmoid),
        );
        assert_eq!(net.input_dim, 4);
        assert_eq!(net.output_dim(), 2);
        // 2 hidden: Linear+Act + Linear+Act + output Linear + output Act = 6
        assert_eq!(net.layer_count(), 6);
        assert!(net.validate().is_ok());
    }

    #[test]
    fn test_validate_empty_layers() {
        let net = NetworkDef::new(4, vec![]);
        assert!(net.validate().is_err());
    }

    #[test]
    fn test_validate_zero_input() {
        let net = NetworkDef::new(0, vec![
            LayerDef::Linear { in_features: 0, out_features: 4 },
        ]);
        assert!(net.validate().is_err());
    }

    #[test]
    fn test_validate_dimension_mismatch() {
        let net = NetworkDef::new(4, vec![
            LayerDef::Linear { in_features: 4, out_features: 8 },
            LayerDef::Linear { in_features: 3, out_features: 2 }, // expects 3, gets 8
        ]);
        let err = net.validate();
        assert!(err.is_err());
        assert!(err.unwrap_err().to_string().contains("expects input_dim=3"));
    }

    #[test]
    fn test_validate_correct_chain() {
        let net = NetworkDef::new(4, vec![
            LayerDef::Linear { in_features: 4, out_features: 8 },
            LayerDef::Activation { function: ActivationType::ReLU },
            LayerDef::Linear { in_features: 8, out_features: 2 },
        ]);
        assert!(net.validate().is_ok());
        assert_eq!(net.output_dim(), 2);
    }

    #[test]
    fn test_validate_rnn_chain() {
        let net = NetworkDef::new(4, vec![
            LayerDef::Rnn { input_size: 4, hidden_size: 8 },
            LayerDef::Linear { in_features: 8, out_features: 2 },
        ]);
        assert!(net.validate().is_ok());
    }

    #[test]
    fn test_validate_gru_chain() {
        let net = NetworkDef::new(4, vec![
            LayerDef::Gru { input_size: 4, hidden_size: 16 },
            LayerDef::Activation { function: ActivationType::Tanh },
            LayerDef::Linear { in_features: 16, out_features: 2 },
        ]);
        assert!(net.validate().is_ok());
        assert_eq!(net.output_dim(), 2);
    }

    #[test]
    fn test_json_roundtrip() {
        let net = NetworkDef::mlp(
            2, &[8], 1,
            ActivationType::Tanh,
            Some(ActivationType::Sigmoid),
        );
        let json = net.to_json().unwrap();
        let restored = NetworkDef::from_json(&json).unwrap();
        assert_eq!(restored.input_dim, 2);
        assert_eq!(restored.layer_count(), 4);
        assert_eq!(restored.layers, net.layers);
    }

    #[test]
    fn test_compile_mlp() {
        let net = NetworkDef::mlp(
            2, &[4], 1,
            ActivationType::ReLU,
            Some(ActivationType::Sigmoid),
        );
        let compiled = net.compile(Box::new(CPUBackend)).unwrap();

        // Check graph was built
        assert!(compiled.graph.nodes().len() > 0);
        assert!(compiled.graph.params().len() > 0);

        // Forward pass should work
        let mut graph = compiled.graph;
        let result = graph.execute(compiled.output_node).unwrap();
        assert_eq!(result.shape(), &[1, 1]);
    }

    #[test]
    fn test_compile_with_rnn() {
        let net = NetworkDef::new(4, vec![
            LayerDef::Rnn { input_size: 4, hidden_size: 8 },
            LayerDef::Linear { in_features: 8, out_features: 2 },
        ]);
        let compiled = net.compile(Box::new(CPUBackend)).unwrap();
        assert_eq!(compiled.stateful_layers.len(), 1);

        let mut graph = compiled.graph;
        let result = graph.execute(compiled.output_node).unwrap();
        assert_eq!(result.shape(), &[1, 2]);
    }

    #[test]
    fn test_compile_with_gru() {
        let net = NetworkDef::new(4, vec![
            LayerDef::Gru { input_size: 4, hidden_size: 8 },
            LayerDef::Linear { in_features: 8, out_features: 1 },
        ]);
        let compiled = net.compile(Box::new(CPUBackend)).unwrap();
        assert_eq!(compiled.stateful_layers.len(), 1);

        let mut graph = compiled.graph;
        let result = graph.execute(compiled.output_node).unwrap();
        assert_eq!(result.shape(), &[1, 1]);
    }

    #[test]
    fn test_compile_invalid_definition() {
        let net = NetworkDef::new(4, vec![
            LayerDef::Linear { in_features: 999, out_features: 8 }, // mismatch
        ]);
        assert!(net.compile(Box::new(CPUBackend)).is_err());
    }

    #[test]
    fn test_compiled_network_states() {
        let net = NetworkDef::new(2, vec![
            LayerDef::Gru { input_size: 2, hidden_size: 4 },
            LayerDef::Linear { in_features: 4, out_features: 1 },
        ]);
        let mut compiled = net.compile(Box::new(CPUBackend)).unwrap();

        // Forward pass
        compiled.graph.execute(compiled.output_node).unwrap();
        compiled.update_states();

        // Reset
        compiled.reset_states();
    }

    #[test]
    fn test_layer_def_output_dim() {
        assert_eq!(
            LayerDef::Linear { in_features: 4, out_features: 8 }.output_dim(4),
            8
        );
        assert_eq!(
            LayerDef::Activation { function: ActivationType::ReLU }.output_dim(8),
            8
        );
        assert_eq!(
            LayerDef::Rnn { input_size: 4, hidden_size: 16 }.output_dim(4),
            16
        );
        assert_eq!(
            LayerDef::Gru { input_size: 4, hidden_size: 32 }.output_dim(4),
            32
        );
    }
}
