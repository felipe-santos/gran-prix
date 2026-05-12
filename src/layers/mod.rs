pub mod linear;
pub mod activation;
pub mod rnn;
pub mod gru;
pub mod batchnorm;

pub use linear::Linear;
pub use activation::{Activation, ActivationType};
pub use rnn::RNNCell;
pub use gru::GRUCell;
pub use batchnorm::BatchNorm;

/// Builds a parameter name from a layer's prefix and a role suffix.
///
/// Empty prefix returns the empty string, preserving direct-layer behavior for
/// layers used outside of `NetworkDef::compile` (where no prefix is set
/// by default). Non-empty prefix produces `"<prefix>.<role>"`.
pub(crate) fn make_param_name(prefix: &str, role: &str) -> String {
    if prefix.is_empty() {
        String::new()
    } else {
        format!("{prefix}.{role}")
    }
}
