//! Loss / output-head selection of a [`Trainer`]: [`LossKind`], the
//! auto-detection rule and the architecture compatibility check.

use gran_prix::layers::ActivationType;
use gran_prix::network_def::{LayerDef, NetworkDef};
use wasm_bindgen::prelude::*;

/// Loss function used by a [`Trainer`]. Auto-detected from the
/// underlying [`NetworkDef`]'s output dimension at construction time:
/// `output_dim == 1` → `BinaryCrossEntropy`, otherwise
/// `CategoricalCrossEntropy`. Determines:
///
///  - Which loss is used in [`train_batch`] / [`train_batch_multi_class`]
///  - How [`predict_probs`] interprets logits (sigmoid vs row-softmax)
///  - Which methods are valid (binary methods error on multi-class
///    trainers and vice versa)
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LossKind {
    /// Binary classification head — single-logit output, sigmoid for
    /// inference, BCE-with-logits for training.
    BinaryCrossEntropy = 0,
    /// Multi-class classification head — `K`-logit output, row-wise
    /// softmax for inference, CrossEntropy-with-logits for training.
    CategoricalCrossEntropy = 1,
}

impl LossKind {
    /// Auto-detection rule used by `Trainer` constructors that don't
    /// take an explicit `LossKind`. Centralized here so the rule has
    /// one definition and one test surface.
    ///
    /// **Caveats.** Callers who want a 2-class problem expressed as
    /// two independent binary heads (`output_dim == 2`,
    /// `BinaryCrossEntropy`) must use the explicit constructor
    /// [`Trainer::from_network_def_with_loss`]; the auto-detection
    /// rule chooses `CategoricalCrossEntropy` for any
    /// `output_dim > 1`, which is the right default for the common
    /// case (multi-class softmax) but not the only valid choice.
    pub(super) fn from_output_dim(output_dim: usize) -> Self {
        if output_dim == 1 {
            LossKind::BinaryCrossEntropy
        } else {
            LossKind::CategoricalCrossEntropy
        }
    }
}

/// Validates that the network's output layer is compatible with the
/// chosen `LossKind`. Returns an error if the terminal activation
/// would compose incorrectly with the loss's gradient computation:
///
///  - `BinaryCrossEntropy` uses `BCEWithLogits` (applies sigmoid
///    internally during the gradient calculation). A network ending
///    in `Sigmoid` would apply sigmoid twice — output of the
///    network would no longer be a logit.
///  - `CategoricalCrossEntropy` uses `CrossEntropyWithLogits`
///    (applies softmax internally). A network ending in `Softmax`
///    would apply softmax twice — gradient computation breaks.
///
/// The check is conservative: it only rejects the unambiguous-bug
/// case of a terminal saturating activation that the corresponding
/// loss function already applies. A user who intentionally builds a
/// network with a non-terminal sigmoid (e.g., as a hidden activation)
/// is not affected.
pub(super) fn validate_loss_compat(net: &NetworkDef, kind: LossKind) -> Result<(), String> {
    let last = match net.layers.last() {
        Some(l) => l,
        None => return Ok(()), // empty network — let `compile` reject this
    };
    if let LayerDef::Activation { function } = last {
        match (function, kind) {
            (ActivationType::Sigmoid, LossKind::BinaryCrossEntropy) => {
                return Err(
                    "Trainer with LossKind::BinaryCrossEntropy expects raw logits as the \
                     network's output, but the architecture ends in Sigmoid. BCEWithLogits \
                     applies sigmoid internally; remove the trailing Sigmoid activation."
                        .to_string(),
                );
            }
            (ActivationType::Softmax, LossKind::CategoricalCrossEntropy) => {
                return Err(
                    "Trainer with LossKind::CategoricalCrossEntropy expects raw logits as \
                     the network's output, but the architecture ends in Softmax. \
                     CrossEntropyWithLogits applies softmax internally; remove the trailing \
                     Softmax activation."
                        .to_string(),
                );
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod loss_compat_tests {
    use super::*;
    
    #[test]
    fn validate_loss_compat_rejects_terminal_sigmoid_with_bce() {
        let net = NetworkDef::new(2, vec![
            LayerDef::Linear { in_features: 2, out_features: 1 },
            LayerDef::Activation { function: ActivationType::Sigmoid },
        ]);
        let err = validate_loss_compat(&net, LossKind::BinaryCrossEntropy).unwrap_err();
        assert!(err.contains("Sigmoid"), "expected Sigmoid diagnostic, got: {err}");
    }

    #[test]
    fn validate_loss_compat_rejects_terminal_softmax_with_cce() {
        let net = NetworkDef::new(2, vec![
            LayerDef::Linear { in_features: 2, out_features: 3 },
            LayerDef::Activation { function: ActivationType::Softmax },
        ]);
        let err = validate_loss_compat(&net, LossKind::CategoricalCrossEntropy).unwrap_err();
        assert!(err.contains("Softmax"), "expected Softmax diagnostic, got: {err}");
    }

    #[test]
    fn validate_loss_compat_accepts_compatible_architectures() {
        let net1 = NetworkDef::new(2, vec![
            LayerDef::Linear { in_features: 2, out_features: 1 },
        ]);
        assert!(validate_loss_compat(&net1, LossKind::BinaryCrossEntropy).is_ok());

        let net2 = NetworkDef::new(2, vec![
            LayerDef::Linear { in_features: 2, out_features: 3 },
        ]);
        assert!(validate_loss_compat(&net2, LossKind::CategoricalCrossEntropy).is_ok());

        let net3 = NetworkDef::new(2, vec![
            LayerDef::Linear { in_features: 2, out_features: 4 },
            LayerDef::Activation { function: ActivationType::Sigmoid },
            LayerDef::Linear { in_features: 4, out_features: 1 },
        ]);
        assert!(validate_loss_compat(&net3, LossKind::BinaryCrossEntropy).is_ok());
    }
}
