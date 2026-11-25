//! Architecture introspection exported to JS (roadmap E1.2, proposals R2/R3).
//!
//! - [`validate_network_def`] (`validateNetworkDef`): checks a `NetworkDef`
//!   JSON string without constructing a `Trainer`, and **never throws** for
//!   an invalid architecture: every problem is reported in `errors`.
//! - `Trainer.paramShapes()` (see `trainer.rs`): per-parameter name, shape
//!   and offset into the flat `getWeights()` vector, so a consumer can slice
//!   the weights without knowing the layout rules.
//!
//! The logic lives in plain-Rust functions ([`summarize_network_def`],
//! [`param_shapes`]) that are unit-tested natively; the `JsValue` conversion
//! on top of them is a thin layer (`JsValue` cannot be built off wasm32).

use gran_prix::backend::cpu::CPUBackend;
use gran_prix::network_def::NetworkDef;
use gran_prix::params::ParamStore;
use wasm_bindgen::prelude::*;

/// Result of checking a `NetworkDef` JSON. Dimensions and the parameter
/// count are only filled in when the definition is valid.
#[derive(Debug, Clone, PartialEq)]
pub struct NetworkSummary {
    pub errors: Vec<String>,
    pub input_dim: Option<usize>,
    pub output_dim: Option<usize>,
    pub param_count: Option<usize>,
}

impl NetworkSummary {
    pub fn ok(&self) -> bool {
        self.errors.is_empty()
    }

    fn invalid(error: String) -> Self {
        Self { errors: vec![error], input_dim: None, output_dim: None, param_count: None }
    }
}

/// Parses, validates and compiles `json` (`NetworkDef::from_json` +
/// `validate` + a seeded compile to count the parameters). Compiling also
/// runs the graph verifier, so an architecture that validates but cannot be
/// built is reported as invalid too.
pub fn summarize_network_def(json: &str) -> NetworkSummary {
    let net = match NetworkDef::from_json(json) {
        Ok(n) => n,
        Err(e) => return NetworkSummary::invalid(e.to_string()),
    };
    if let Err(e) = net.validate() {
        return NetworkSummary::invalid(e.to_string());
    }
    // The seed is irrelevant for counting; fixing it avoids the thread RNG.
    let compiled = match net.compile_seeded(Box::new(CPUBackend), 0) {
        Ok(c) => c,
        Err(e) => return NetworkSummary::invalid(e.to_string()),
    };
    NetworkSummary {
        errors: Vec::new(),
        input_dim: Some(net.input_dim),
        output_dim: Some(net.output_dim()),
        param_count: Some(compiled.graph.params().total_params()),
    }
}

/// Name, shape and position of one parameter inside the flat weight vector.
#[derive(Debug, Clone, PartialEq)]
pub struct ParamShape {
    pub name: String,
    pub shape: Vec<usize>,
    pub offset: usize,
    pub len: usize,
}

/// Lists every parameter in `ParamStore::export_flat` order (registration
/// order), with the offset of its first element in the flat vector.
pub fn param_shapes(store: &ParamStore) -> Vec<ParamShape> {
    let mut offset = 0;
    store
        .iter()
        .map(|(id, tensor)| {
            let len = tensor.len();
            let entry = ParamShape {
                name: store.name(id).to_string(),
                shape: tensor.shape().to_vec(),
                offset,
                len,
            };
            offset += len;
            entry
        })
        .collect()
}

// ── JS conversion ──────────────────────────────────────────────────────────

fn set(obj: &js_sys::Object, key: &str, value: &JsValue) {
    // `Reflect::set` on a fresh plain object cannot fail.
    let _ = js_sys::Reflect::set(obj, &JsValue::from_str(key), value);
}

fn number(n: usize) -> JsValue {
    JsValue::from_f64(n as f64)
}

/// Checks a `NetworkDef` JSON string. Returns
/// `{ ok: boolean, errors: string[], inputDim?: number, outputDim?: number, paramCount?: number }`.
/// Invalid JSON and architecture errors (dimension mismatches, zero sizes,
/// bad dropout rates, ...) are reported in `errors`; this function does not
/// throw for them.
#[wasm_bindgen(js_name = validateNetworkDef)]
pub fn validate_network_def(json: &str) -> JsValue {
    let summary = summarize_network_def(json);
    let obj = js_sys::Object::new();
    set(&obj, "ok", &JsValue::from_bool(summary.ok()));
    let errors = js_sys::Array::new();
    for e in &summary.errors {
        errors.push(&JsValue::from_str(e));
    }
    set(&obj, "errors", &errors);
    if let Some(v) = summary.input_dim {
        set(&obj, "inputDim", &number(v));
    }
    if let Some(v) = summary.output_dim {
        set(&obj, "outputDim", &number(v));
    }
    if let Some(v) = summary.param_count {
        set(&obj, "paramCount", &number(v));
    }
    obj.into()
}

/// Converts [`param_shapes`] to `{ name, shape: number[], offset, len }[]`.
pub(crate) fn param_shapes_to_js(store: &ParamStore) -> JsValue {
    let out = js_sys::Array::new();
    for p in param_shapes(store) {
        let obj = js_sys::Object::new();
        set(&obj, "name", &JsValue::from_str(&p.name));
        let shape = js_sys::Array::new();
        for d in &p.shape {
            shape.push(&number(*d));
        }
        set(&obj, "shape", &shape);
        set(&obj, "offset", &number(p.offset));
        set(&obj, "len", &number(p.len));
        out.push(&obj);
    }
    out.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use gran_prix::network_def::{ActivationType, LayerDef};

    fn json(input_dim: usize, layers: Vec<LayerDef>) -> String {
        NetworkDef::new(input_dim, layers).to_json().unwrap()
    }

    fn linear(i: usize, o: usize) -> LayerDef {
        LayerDef::Linear { in_features: i, out_features: o }
    }

    #[test]
    fn valid_def_reports_dims_and_param_count() {
        let j = json(
            2,
            vec![
                linear(2, 8),
                LayerDef::Activation { function: ActivationType::Tanh },
                linear(8, 1),
            ],
        );
        let s = summarize_network_def(&j);
        assert!(s.ok(), "unexpected errors: {:?}", s.errors);
        assert_eq!(s.input_dim, Some(2));
        assert_eq!(s.output_dim, Some(1));
        // 2*8 + 8 + 8*1 + 1
        assert_eq!(s.param_count, Some(33));
    }

    #[test]
    fn invalid_json_is_reported_not_thrown() {
        let s = summarize_network_def("{ not json");
        assert!(!s.ok());
        assert_eq!(s.errors.len(), 1);
        assert!(s.input_dim.is_none() && s.output_dim.is_none() && s.param_count.is_none());
    }

    #[test]
    fn dimension_mismatch_is_reported() {
        let j = json(2, vec![linear(2, 8), linear(5, 1)]);
        let s = summarize_network_def(&j);
        assert!(!s.ok());
        assert!(s.errors[0].contains("layer 1"), "got: {:?}", s.errors);
        assert!(s.param_count.is_none());
    }

    #[test]
    fn empty_layers_and_bad_dropout_are_reported() {
        assert!(!summarize_network_def(&json(2, vec![])).ok());
        let j = json(2, vec![linear(2, 2), LayerDef::Dropout { rate: 1.5 }]);
        assert!(!summarize_network_def(&j).ok());
    }

    #[test]
    fn param_shapes_follow_export_flat_order() {
        let j = json(
            3,
            vec![
                linear(3, 4),
                LayerDef::Activation { function: ActivationType::ReLU },
                linear(4, 2),
            ],
        );
        let net = NetworkDef::from_json(&j).unwrap();
        let compiled = net.compile_seeded(Box::new(CPUBackend), 7).unwrap();
        let store = compiled.graph.params();
        let shapes = param_shapes(store);

        let names: Vec<&str> = shapes.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["layers[0].weight", "layers[0].bias", "layers[2].weight", "layers[2].bias"]);
        assert_eq!(shapes[0].shape, vec![3, 4]);
        assert_eq!(shapes[1].shape, vec![1, 4]);
        assert_eq!(shapes[2].shape, vec![4, 2]);
        assert_eq!(shapes[3].shape, vec![1, 2]);

        // Offsets are contiguous and cover the whole flat vector.
        let mut expected = 0;
        for p in &shapes {
            assert_eq!(p.offset, expected);
            assert_eq!(p.len, p.shape.iter().product::<usize>());
            expected += p.len;
        }
        let flat = store.export_flat().unwrap();
        assert_eq!(expected, flat.len());
        assert_eq!(expected, store.total_params());
    }
}
