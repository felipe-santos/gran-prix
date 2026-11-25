//! Constructors of the [`Trainer`] (all share `build_with_seed`).

use super::loss_kind::validate_loss_compat;
use super::{js_err, LossKind, Trainer};
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::layers::ActivationType;
use gran_prix::network_def::NetworkDef;
use gran_prix::Tensor;
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl Trainer {
    /// Creates a trainer with a simple MLP: Input → (Linear+Tanh)×N → Linear(1).
    ///
    /// This is the constructor used by the Playground for binary classification.
    #[wasm_bindgen(constructor)]
    pub fn new(input_dim: usize, hidden_layers: Vec<usize>) -> Result<Trainer, JsValue> {
        let net = NetworkDef::mlp(
            input_dim,
            &hidden_layers,
            1, // single output for binary classification
            ActivationType::Tanh,
            None, // no output activation (logits — BCE with logits applies sigmoid)
        );
        Self::build(net, LossKind::BinaryCrossEntropy)
    }

    /// Creates a trainer from a [`NetworkDef`] JSON string.
    ///
    /// This replaces the old `WasmArchitecture` format. The JSON schema
    /// is defined by the core `NetworkDef` type:
    ///
    /// ```json
    /// {
    ///   "input_dim": 2,
    ///   "layers": [
    ///     { "type": "linear", "in_features": 2, "out_features": 8 },
    ///     { "type": "activation", "function": "relu" },
    ///     { "type": "linear", "in_features": 8, "out_features": 1 }
    ///   ]
    /// }
    /// ```
    #[wasm_bindgen(js_name = fromNetworkDef)]
    pub fn from_network_def(json: &str) -> Result<Trainer, JsValue> {
        let net = NetworkDef::from_json(json).map_err(js_err)?;
        let loss_kind = LossKind::from_output_dim(net.output_dim());
        Self::build(net, loss_kind)
    }

    /// Like [`from_network_def`], but with an explicit `loss_kind`
    /// instead of auto-detection from `output_dim`. Use this when the
    /// auto-detection rule isn't right — e.g., a network with
    /// `output_dim == 2` that the caller wants to treat as two
    /// independent binary heads (`BinaryCrossEntropy`) rather than a
    /// 2-class softmax (`CategoricalCrossEntropy`).
    ///
    /// Errors if the terminal activation in the architecture is
    /// incompatible with the chosen loss (see `validate_loss_compat`).
    #[wasm_bindgen(js_name = fromNetworkDefWithLoss)]
    pub fn from_network_def_with_loss(
        json: &str,
        loss_kind: LossKind,
    ) -> Result<Trainer, JsValue> {
        let net = NetworkDef::from_json(json).map_err(js_err)?;
        Self::build(net, loss_kind)
    }

    /// Like [`Trainer::from_network_def`], but all random weights are derived
    /// deterministically from `seed`: the same `(json, seed)` always produces
    /// bit-identical weights (`get_weights()`), independent of `Math.random`
    /// or the platform RNG.
    ///
    /// The seed is a `u32` so JavaScript callers can pass a plain `number`
    /// (no `BigInt`); it is widened to `u64` internally.
    #[wasm_bindgen(js_name = fromNetworkDefSeeded)]
    pub fn from_network_def_seeded(json: &str, seed: u32) -> Result<Trainer, JsValue> {
        let net = NetworkDef::from_json(json).map_err(js_err)?;
        let loss_kind = LossKind::from_output_dim(net.output_dim());
        Self::build_with_seed(net, loss_kind, Some(u64::from(seed)))
    }

    /// Seeded variant of [`Trainer::from_network_def_with_loss`]
    /// (explicit `loss_kind`, deterministic weights from a `u32` `seed`).
    #[wasm_bindgen(js_name = fromNetworkDefWithLossSeeded)]
    pub fn from_network_def_with_loss_seeded(
        json: &str,
        loss_kind: LossKind,
        seed: u32,
    ) -> Result<Trainer, JsValue> {
        let net = NetworkDef::from_json(json).map_err(js_err)?;
        Self::build_with_seed(net, loss_kind, Some(u64::from(seed)))
    }

    /// Internal builder shared by all public constructors. Centralizes
    /// the validation, JSON snapshot, and graph compilation so the
    /// invariants (loss/architecture compatibility, canonical JSON,
    /// pre-allocated input buffer) hold uniformly across construction
    /// paths.
    fn build(net: NetworkDef, loss_kind: LossKind) -> Result<Trainer, JsValue> {
        Self::build_with_seed(net, loss_kind, None)
    }

    /// [`Trainer::build`] with optional deterministic initialization
    /// (`Some(seed)` uses `NetworkDef::compile_seeded`).
    fn build_with_seed(
        net: NetworkDef,
        loss_kind: LossKind,
        seed: Option<u64>,
    ) -> Result<Trainer, JsValue> {
        validate_loss_compat(&net, loss_kind).map_err(|e| JsValue::from_str(&e))?;

        let input_dim = net.input_dim;
        let output_dim = net.output_dim();
        let net_json = net.to_json().map_err(js_err)?;
        let compiled = match seed {
            Some(s) => net.compile_seeded(Box::new(CPUBackend), s),
            None => net.compile(Box::new(CPUBackend)),
        }
        .map_err(js_err)?;

        Ok(Trainer {
            graph: RefCell::new(compiled.graph),
            input_node: compiled.input_node.0,
            output_node: compiled.output_node.0,
            input_dim,
            output_dim,
            input_tensor: RefCell::new(Tensor::new_zeros(&[1, input_dim])),
            optimizer: RefCell::new(gran_prix::optim::Adam::new(0.01)),
            net_json,
            loss_kind,
        })
    }
}
