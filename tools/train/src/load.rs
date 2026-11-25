//! Loading and verifying a ModelPackage directory, and scoring raw (pre-normalization)
//! feature vectors with it. This is the Rust runtime of the package: the same
//! `NetworkDef::from_json` + `import_flat` path any Rust consumer would use.

use crate::canonical::sha256_id;
use crate::error::{parse_json, read_bytes, read_text, Result};
use crate::identity::{model_id, network_def_digest};
use crate::invalid;
use crate::net::Net;
use crate::normalize::{Normalizer, ZScore};
use gran_prix::network_def::NetworkDef;
use serde_json::Value;
use std::path::Path;

#[derive(Debug)]
pub struct Package {
    pub model: Value,
    pub net_def: NetworkDef,
    pub weights: Vec<f32>,
    pub normalizer: Normalizer,
    pub schema_id: String,
    pub dim: usize,
    pub accept: f32,
    pub escalate: f32,
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Result<&'a str> {
    let mut cur = v;
    for p in path {
        cur = cur.get(*p).ok_or_else(|| invalid!("model.json: missing {}", path.join(".")))?;
    }
    cur.as_str().ok_or_else(|| invalid!("model.json: {} is not a string", path.join(".")))
}

fn f32_list(v: &Value, what: &str) -> Result<Vec<f32>> {
    v.as_array()
        .ok_or_else(|| invalid!("model.json: {what} is not an array"))?
        .iter()
        .map(|x| x.as_f64().map(|f| f as f32).ok_or_else(|| invalid!("model.json: {what} has a non-number")))
        .collect()
}

fn f32_at(v: &Value, path: &[&str]) -> Result<f32> {
    let mut cur = v;
    for p in path {
        cur = cur.get(*p).ok_or_else(|| invalid!("model.json: missing {}", path.join(".")))?;
    }
    cur.as_f64().map(|f| f as f32).ok_or_else(|| invalid!("model.json: {} is not a number", path.join(".")))
}

/// Loads `dir`, checking: digests of `network_def.json` (canonical) and `weights.f32le`,
/// `model_id`, weight count, and the parameter layout against the compiled network.
pub fn load_package(dir: &Path) -> Result<Package> {
    let model: Value = parse_json(&read_text(&dir.join("model.json"))?, "model.json")?;
    if str_at(&model, &["format"])? != "gran-prix.model-package" {
        return Err(invalid!("model.json is not a gran-prix.model-package"));
    }
    let net_text = read_text(&dir.join(str_at(&model, &["files", "network_def", "path"])?))?;
    if network_def_digest(&net_text)? != str_at(&model, &["digest", "network_def"])? {
        return Err(invalid!("network_def.json does not match digest.network_def"));
    }
    let weight_bytes = read_bytes(&dir.join(str_at(&model, &["files", "weights", "path"])?))?;
    if sha256_id(&weight_bytes) != str_at(&model, &["digest", "weights"])? {
        return Err(invalid!("weights.f32le does not match digest.weights"));
    }
    if weight_bytes.len() % 4 != 0 {
        return Err(invalid!("weights.f32le has {} bytes, not a multiple of 4", weight_bytes.len()));
    }
    let weights: Vec<f32> = weight_bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    if model_id(&model)? != str_at(&model, &["model_id"])? {
        return Err(invalid!("model_id does not match the behavior hash"));
    }

    let net_def = NetworkDef::from_json(&net_text)?;
    let mut net = Net::new(&net_def, Some(0))?;
    net.load_weights(&weights)?;
    check_layout(&model, &net)?;

    let fs = model.get("feature_spec").ok_or_else(|| invalid!("model.json: missing feature_spec"))?;
    let dim = fs.get("dim").and_then(Value::as_u64).ok_or_else(|| invalid!("model.json: feature_spec.dim"))? as usize;
    if dim != net_def.input_dim {
        return Err(invalid!("feature_spec.dim {dim} != network input_dim {}", net_def.input_dim));
    }
    let normalizer = match str_at(fs, &["normalization", "kind"])? {
        "none" => Normalizer::None,
        "zscore" => {
            let z = &fs["normalization"];
            let (mean, std) = (f32_list(&z["mean"], "normalization.mean")?, f32_list(&z["std"], "normalization.std")?);
            if mean.len() != dim || std.len() != dim {
                return Err(invalid!("normalization.mean/std must have {dim} entries"));
            }
            let eps = z.get("eps").and_then(Value::as_f64).ok_or_else(|| invalid!("normalization.eps"))?;
            Normalizer::ZScore(ZScore { mean, std, eps, constant_features: Vec::new() })
        }
        other => return Err(invalid!("unknown normalization kind \"{other}\"")),
    };
    Ok(Package {
        schema_id: str_at(fs, &["schema_id"])?.to_string(),
        accept: f32_at(&model, &["thresholds", "accept"])?,
        escalate: f32_at(&model, &["thresholds", "escalate"])?,
        model,
        net_def,
        weights,
        normalizer,
        dim,
    })
}

fn check_layout(model: &Value, net: &Net) -> Result<()> {
    let declared = model["network"]["param_layout"].as_array().ok_or_else(|| invalid!("model.json: network.param_layout"))?;
    let actual = net.param_layout();
    if declared.len() != actual.len() {
        return Err(invalid!("param_layout has {} entries, the network has {}", declared.len(), actual.len()));
    }
    for (d, a) in declared.iter().zip(&actual) {
        let shape: Vec<usize> = d["shape"].as_array().map_or(Vec::new(), |s| s.iter().filter_map(|x| x.as_u64().map(|n| n as usize)).collect());
        if d["name"].as_str() != Some(a.name.as_str())
            || shape != a.shape
            || d["offset"].as_u64() != Some(a.offset as u64)
            || d["length"].as_u64() != Some(a.length as u64)
        {
            return Err(invalid!("param_layout entry \"{}\" does not match the compiled network", a.name));
        }
    }
    Ok(())
}

/// Scores raw (pre-normalization) feature vectors with a loaded package.
pub struct Predictor {
    net: Net,
    normalizer: Normalizer,
    dim: usize,
}

impl Predictor {
    pub fn new(net_def: &NetworkDef, weights: &[f32], normalizer: Normalizer) -> Result<Predictor> {
        let mut net = Net::new(net_def, Some(0))?;
        net.load_weights(weights)?;
        Ok(Predictor { net, normalizer, dim: net_def.input_dim })
    }

    pub fn from_package(p: &Package) -> Result<Predictor> {
        Predictor::new(&p.net_def, &p.weights, p.normalizer.clone())
    }

    /// Logits of `n` row-major raw rows: normalize, then forward in eval mode.
    pub fn logits(&mut self, raw: &[f32], n: usize) -> Result<Vec<f32>> {
        let x = self.normalizer.apply_matrix(raw, self.dim);
        self.net.logits(&x, n)
    }
}
