//! Weight access, architecture introspection and the parameter-index API
//! (`paramCount`, `paramName`, `paramNames`, `paramShapes`, freezing).

use super::{js_err, LossKind, Trainer};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl Trainer {
    // ── Weight Access ──────────────────────────────────────────────────────

    pub fn get_weights(&self) -> Result<Vec<f32>, JsValue> {
        self.graph.borrow().params().export_flat().map_err(js_err)
    }

    pub fn get_gradient_norms(&self) -> Result<Vec<f32>, JsValue> {
        self.graph.borrow().params().gradient_norms().map_err(js_err)
    }

    pub fn import_weights(&self, weights: &[f32]) -> Result<(), JsValue> {
        self.graph.borrow_mut().params_mut().import_flat(weights).map_err(js_err)
    }

    // ── Architecture introspection ─────────────────────────────────────────

    /// Returns the canonical [`NetworkDef`] JSON used to construct this
    /// trainer.
    ///
    /// The pair `(networkDefJson(), getWeights())` is the canonical
    /// serialization contract for distributing a trained model:
    /// reconstruct via [`from_network_def`] + [`import_weights`] and
    /// the predictions are bit-identical (pinned by
    /// `tests/persistence_e2e.rs`). The full `Graph` serde path also
    /// works for trained MLPs (pinned by
    /// `serde_json_to_string_round_trips_a_trained_graph`), but uses a
    /// less explicit contract — prefer the JSON+weights pair for
    /// anything crossing a trust boundary (disk, network, browser
    /// storage).
    #[wasm_bindgen(js_name = networkDefJson)]
    pub fn network_def_json(&self) -> String {
        self.net_json.clone()
    }

    /// Returns the input feature dimensionality.
    #[wasm_bindgen(js_name = inputDim)]
    pub fn input_dim(&self) -> usize {
        self.input_dim
    }

    /// Returns the output dimensionality (number of classes for
    /// multi-class, 1 for binary).
    #[wasm_bindgen(js_name = outputDim)]
    pub fn output_dim(&self) -> usize {
        self.output_dim
    }

    /// Returns the loss/output mode for this trainer. See [`LossKind`]
    /// for the auto-detection rule.
    #[wasm_bindgen(js_name = lossKind)]
    pub fn loss_kind(&self) -> LossKind {
        self.loss_kind
    }

    // ── Parameter freezing (transfer-learning support) ─────────────────────

    /// Freezes every trainable parameter whose registered name starts
    /// with `prefix`, returning the indices of the parameters that
    /// were affected (in registration order).
    ///
    /// `NetworkDef::compile` registers parameters with names like
    /// `"layers[3].weight"`, so a prefix of `"layers[3]"` freezes the
    /// fourth layer atomically. Layers indexed by activation-only
    /// `LayerDef`s contribute no parameters; their indices appear as
    /// gaps in the namespace.
    ///
    /// An empty return vector means no parameter matched — common if
    /// the caller passed a typo. The method does not error in that
    /// case because the absence of a match isn't necessarily a bug.
    /// Returning the affected indices lets callers audit "did I
    /// freeze the right parameters?" — for instance by passing the
    /// vector to [`param_name`] for a logging readback.
    #[wasm_bindgen(js_name = freezeByPrefix)]
    pub fn freeze_by_prefix(&self, prefix: &str) -> Vec<usize> {
        self.graph
            .borrow_mut()
            .params_mut()
            .freeze_by_name_prefix(prefix)
            .into_iter()
            .map(|p| p.0)
            .collect()
    }

    /// Inverse of [`freezeByPrefix`].
    #[wasm_bindgen(js_name = unfreezeByPrefix)]
    pub fn unfreeze_by_prefix(&self, prefix: &str) -> Vec<usize> {
        self.graph
            .borrow_mut()
            .params_mut()
            .unfreeze_by_name_prefix(prefix)
            .into_iter()
            .map(|p| p.0)
            .collect()
    }

    /// Number of parameter **tensors** (weight matrices and bias vectors),
    /// i.e. `paramNames().length`; the index range of [`param_name`] and
    /// [`is_frozen_by_index`]. A `Linear` layer contributes two (weight and
    /// bias). This is NOT the number of floats in `get_weights()`: for that
    /// use [`weight_count`].
    #[wasm_bindgen(js_name = paramTensorCount)]
    pub fn param_tensor_count(&self) -> usize {
        self.graph.borrow().params().len()
    }

    /// Alias of [`param_tensor_count`], kept for existing JS callers.
    ///
    /// @deprecated The name is ambiguous (tensors, not floats; the
    /// `weightCount` of `validateNetworkDef` used to be called `paramCount`
    /// and counts floats). Use `paramTensorCount()` or `weightCount()`.
    #[wasm_bindgen(js_name = paramCount)]
    pub fn param_count(&self) -> usize {
        self.param_tensor_count()
    }

    /// Total number of scalar weights (floats) of the network:
    /// `get_weights().length` and the expected length of `import_weights` input,
    /// without copying them across the boundary. Equals the `weightCount` that
    /// `validateNetworkDef` reports for the same NetworkDef.
    #[wasm_bindgen(js_name = weightCount)]
    pub fn weight_count(&self) -> usize {
        self.graph.borrow().params().total_params()
    }

    /// Returns the registered name of the parameter at `index`.
    ///
    /// Returns the empty string for out-of-range indices rather than
    /// erroring — this matches the convention `wasm-bindgen` uses
    /// for getters, where a `null`/empty value is more ergonomic than
    /// a thrown exception. Callers that need bound-checked access can
    /// gate on [`param_tensor_count`].
    #[wasm_bindgen(js_name = paramName)]
    pub fn param_name(&self, index: usize) -> String {
        let g = self.graph.borrow();
        let names = g.params().names();
        names.get(index).map(|s| s.to_string()).unwrap_or_default()
    }

    /// Returns the registered names of all parameters as a
    /// `string[]`. **Allocates and clones each name on every call.**
    /// For hot paths, prefer [`param_tensor_count`] + [`param_name`] or
    /// cache the result on the JS side.
    #[wasm_bindgen(js_name = paramNames)]
    pub fn param_names(&self) -> Vec<String> {
        self.graph
            .borrow()
            .params()
            .names()
            .into_iter()
            .map(String::from)
            .collect()
    }

    /// Returns, for every parameter in `getWeights()` order, a
    /// `{ name, shape: number[], offset, len }` entry: `offset`/`len` locate
    /// the parameter inside the flat weight vector and `shape` is its tensor
    /// shape (row-major), e.g. a `Linear` weight is `[in, out]` and its bias
    /// `[1, out]`. Lets consumers slice the weights without knowing the
    /// layout rules. Allocates on every call.
    #[wasm_bindgen(js_name = paramShapes)]
    pub fn param_shapes(&self) -> JsValue {
        crate::network_info::param_shapes_to_js(self.graph.borrow().params())
    }

    /// Returns whether the parameter at `index` is currently frozen.
    /// Out-of-range indices return `false` (consistent with
    /// [`param_name`]'s out-of-range behavior).
    #[wasm_bindgen(js_name = isFrozenByIndex)]
    pub fn is_frozen_by_index(&self, index: usize) -> bool {
        let g = self.graph.borrow();
        if index >= g.params().len() {
            return false;
        }
        g.params().is_frozen(gran_prix::ParamId(index))
    }
}
