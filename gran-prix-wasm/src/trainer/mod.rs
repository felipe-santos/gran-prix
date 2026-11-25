//! Online Trainer for Supervised Learning in WASM.
//!
//! Uses [`NetworkDef`] from the core crate for architecture definition,
//! replacing the previous ad-hoc `WasmArchitecture` JSON format.
//!
//! The JS-visible `Trainer` class is declared here; its methods live in
//! cohesive submodules (several `#[wasm_bindgen] impl` blocks):
//!
//! - `loss_kind`: [`LossKind`] and the loss/architecture compatibility check;
//! - `forward`: batched forward pass and output activation;
//! - `build`: constructors;
//! - `training`: `train_*` and the per-sample batch loops;
//! - `params`: weight access, architecture introspection, freezing, `param*`;
//! - `inference`: `predict*` and the decision boundary.

use gran_prix::graph::Graph;
use gran_prix::{GPError, Tensor};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

mod build;
mod forward;
mod inference;
mod loss_kind;
mod params;
mod training;

pub use loss_kind::LossKind;

#[wasm_bindgen]
pub struct Trainer {
    graph: RefCell<Graph>,
    input_node: usize,
    output_node: usize,
    input_dim: usize,
    output_dim: usize,
    input_tensor: RefCell<Tensor>,
    optimizer: RefCell<gran_prix::optim::Adam>,
    /// Canonical `NetworkDef` JSON used to compile this trainer.
    /// Stored once at construction so callers can read it back via
    /// [`network_def_json`] and persist the architecture alongside
    /// flat weights — the canonical serialization contract.
    net_json: String,
    /// Loss function selected at construction based on the
    /// `NetworkDef`'s output dimension. Determines which `train_*` /
    /// `predict_*` methods are valid; using a binary method on a
    /// multi-class trainer (or vice versa) returns an error rather
    /// than silently producing wrong outputs.
    loss_kind: LossKind,
}

/// Helper: convert GPError to JsValue.
fn js_err(e: GPError) -> JsValue {
    JsValue::from_str(&e.to_string())
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_batch_api;
