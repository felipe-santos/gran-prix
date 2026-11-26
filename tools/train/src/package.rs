//! Writes a ModelPackage v1 directory (ADR-003, contract `model-package`):
//! `network_def.json`, `weights.f32le`, `golden.json`, `model.json`, plus a
//! `train_report.json` sidecar with the training curve.

use crate::canonical::{artifact_id, sha256_id};
use crate::config::TrainConfig;
use crate::dataset::{Manifest, Rows};
use crate::error::{create_dir_all, parse_json, read_text, write_bytes, Result};
use crate::identity::{model_id, network_def_digest, now_iso8601, train_cache_key};
use crate::invalid;
use crate::load::Predictor;
use crate::loss::sigmoid_f32;
use crate::normalize::{Normalizer, EPS};
use crate::train::TrainOutcome;
use gran_prix::network_def::LayerDef;
use serde_json::{json, Map, Value};
use std::path::Path;

/// Number of golden cases written at most.
pub const GOLDEN_CASES: usize = 32;
/// Fraction of the training range tolerated beyond `[lo, hi]` before an input is flagged OOD.
pub const OOD_TOLERANCE: f64 = 0.1;
const GOLDEN_TOLERANCE: f64 = 1e-5;
const WASM_ABI: &str = "gran-prix-wasm@0.1";

/// What `feature_spec` needs from the FeatureSchema (the manifest only carries its id).
#[derive(Debug, Clone)]
pub struct FeatureInfo {
    pub schema_id: String,
    pub name: String,
    pub version: String,
    pub unit: String,
    pub names: Vec<String>,
}

impl FeatureInfo {
    /// Reads `feature-schema.json`, checking it is the schema the dataset was built with.
    pub fn from_schema_file(path: &Path, manifest: &Manifest) -> Result<FeatureInfo> {
        let doc: Value = parse_json(&read_text(path)?, "feature-schema.json")?;
        let s = |k: &str| doc.get(k).and_then(Value::as_str).map(str::to_string).ok_or_else(|| invalid!("feature-schema.json: missing \"{k}\""));
        let info = FeatureInfo {
            schema_id: s("schema_id")?,
            name: s("name")?,
            version: s("version")?,
            unit: s("unit")?,
            names: doc
                .get("features")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid!("feature-schema.json: missing features"))?
                .iter()
                .map(|f| f.get("name").and_then(Value::as_str).map(str::to_string).ok_or_else(|| invalid!("feature without a name")))
                .collect::<Result<Vec<_>>>()?,
        };
        if info.schema_id != manifest.feature_schema_id {
            return Err(invalid!("feature schema {} is not the one the dataset was built with ({})", info.schema_id, manifest.feature_schema_id));
        }
        if info.names.len() != manifest.dim {
            return Err(invalid!("feature schema has {} features, the dataset dim is {}", info.names.len(), manifest.dim));
        }
        Ok(info)
    }

    /// Fallback without a schema file: `f0..f{dim-1}` under the manifest's schema id.
    pub fn anonymous(manifest: &Manifest) -> FeatureInfo {
        FeatureInfo {
            schema_id: manifest.feature_schema_id.clone(),
            name: "unnamed".to_string(),
            version: "0.0.0".to_string(),
            unit: "unit".to_string(),
            names: (0..manifest.dim).map(|i| format!("f{i}")).collect(),
        }
    }
}

/// Free-form fields of `model.json` and its provenance that the caller (the pipeline
/// runner, or the user) may set.
#[derive(Debug, Clone, Default)]
pub struct PackageOpts {
    pub name: Option<String>,
    pub task_name: Option<String>,
    pub run_id: Option<String>,
    pub stage_id: Option<String>,
    pub cache_key: Option<String>,
    pub pipeline_spec_id: Option<String>,
    pub created_at: Option<String>,
    /// `provenance.duration_ms`. `None`: the measured wall time of the run. A pipeline runner
    /// fixes it (0) so the whole package, `model.json` included, is byte-reproducible.
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct PackageSummary {
    pub model_id: String,
    pub weights_sha256: String,
}

fn f32v(x: f32) -> Value {
    json!(f64::from(x))
}

fn f32s(xs: &[f32]) -> Value {
    Value::Array(xs.iter().map(|x| f32v(*x)).collect())
}

fn pretty(v: &Value) -> Result<Vec<u8>> {
    let mut text = serde_json::to_string_pretty(v).map_err(|e| invalid!("cannot serialize JSON: {e}"))?;
    text.push('\n');
    Ok(text.into_bytes())
}

/// Evenly spaced rows: up to `k` of `rows`, starting at the first.
fn spaced(rows: &Rows, k: usize) -> Vec<usize> {
    let n = rows.len();
    let take = k.min(n);
    (0..take).map(|i| i * n / take.max(1)).collect()
}

/// Golden inputs: up to [`GOLDEN_CASES`] rows, validation first, topped up from train.
fn golden_inputs(train: &Rows, val: &Rows) -> Vec<(String, Vec<f32>)> {
    let mut out: Vec<(String, Vec<f32>)> = Vec::new();
    for (rows, tag) in [(val, "val"), (train, "train")] {
        let need = GOLDEN_CASES.saturating_sub(out.len());
        for i in spaced(rows, need) {
            out.push((format!("{tag}/{}/{}", rows.group[i], rows.unit[i]), rows.row(i).to_vec()));
        }
    }
    out
}

fn layer_types(outcome: &TrainOutcome) -> Vec<&'static str> {
    let mut seen: Vec<&'static str> = Vec::new();
    for l in &outcome.net_def.layers {
        let t = match l {
            LayerDef::Linear { .. } => "linear",
            LayerDef::Activation { .. } => "activation",
            LayerDef::Dropout { .. } => "dropout",
            LayerDef::Rnn { .. } => "rnn",
            LayerDef::Gru { .. } => "gru",
            LayerDef::BatchNorm { .. } => "batchnorm",
        };
        if !seen.contains(&t) {
            seen.push(t);
        }
    }
    seen
}

fn feature_spec(outcome: &TrainOutcome, features: &FeatureInfo) -> Value {
    let normalization = match &outcome.normalizer {
        Normalizer::None => json!({ "kind": "none" }),
        Normalizer::ZScore(z) => json!({ "kind": "zscore", "mean": f32s(&z.mean), "std": f32s(&z.std), "eps": EPS }),
    };
    json!({
        "schema_id": features.schema_id,
        "name": features.name,
        "version": features.version,
        "dim": features.names.len(),
        "names": features.names,
        "normalization": normalization,
        "ood": { "lo": f32s(&outcome.ood.0), "hi": f32s(&outcome.ood.1), "tolerance": OOD_TOLERANCE },
    })
}

fn train_report(outcome: &TrainOutcome, manifest: &Manifest, config_id: &str, model_id: &str) -> Value {
    let history: Vec<Value> = outcome
        .history
        .iter()
        .map(|h| json!({ "epoch": h.epoch, "lr": h.lr, "train_loss": h.train_loss, "val_loss": h.val_loss, "val_f1": h.val_f1 }))
        .collect();
    let constant: Vec<usize> = match &outcome.normalizer {
        Normalizer::ZScore(z) => z.constant_features.clone(),
        Normalizer::None => Vec::new(),
    };
    let mut report = json!({
        "format": "gp-train.train-report",
        "format_version": "0.1.0",
        "model_id": model_id,
        "dataset_id": manifest.dataset_id,
        "train_config_id": config_id,
        "seed": outcome.seed,
        "n_train": outcome.n_train,
        "n_train_pos": outcome.n_train_pos,
        "pos_weight": f64::from(outcome.pos_weight),
        "epochs_run": outcome.history.len(),
        "best_epoch": outcome.best_epoch,
        "stopped_early": outcome.stopped_early,
        "constant_features_std_set_to_1": constant,
        "thresholds": {
            "accept": f64::from(outcome.thresholds.accept),
            "escalate": f64::from(outcome.thresholds.escalate),
            "margin": f64::from(outcome.thresholds.margin),
        },
        "val_metrics": outcome.val_metrics.as_ref().map(|m| m.to_json()),
        "history": history,
    });
    // Only when it was used: a report without a weight is byte-identical to the one of the unweighted trainer.
    if outcome.row_weight {
        if let Some(map) = report.as_object_mut() {
            map.insert("sample_weight".to_string(), json!("row"));
        }
    }
    report
}

/// Everything `write_package` needs besides the output directory and the free-form options.
pub struct PackageInputs<'a> {
    pub outcome: &'a TrainOutcome,
    /// The filtered row sets the model was trained on (golden inputs are drawn from them).
    pub train: &'a Rows,
    pub val: &'a Rows,
    pub manifest: &'a Manifest,
    pub features: &'a FeatureInfo,
    /// The config document after the seed override.
    pub config_raw: &'a Value,
}

/// Writes the package into `out_dir` (created if missing; the five files are overwritten).
pub fn write_package(out_dir: &Path, inputs: &PackageInputs, opts: &PackageOpts) -> Result<PackageSummary> {
    let PackageInputs { outcome, train, val, manifest, features, config_raw } = *inputs;
    create_dir_all(out_dir)?;

    // network_def.json: compact; its digest is over the canonical form of the parsed text.
    let net_text = serde_json::to_string(&outcome.net_def).map_err(|e| invalid!("cannot serialize the NetworkDef: {e}"))?;
    let net_digest = network_def_digest(&net_text)?;

    // weights.f32le: raw export_flat, little-endian, hashed as bytes.
    let weight_bytes: Vec<u8> = outcome.weights.iter().flat_map(|w| w.to_le_bytes()).collect();
    let weights_digest = sha256_id(&weight_bytes);

    // golden.json: raw (pre-normalization) inputs and the outputs of the Rust runtime.
    let inputs = golden_inputs(train, val);
    let flat: Vec<f32> = inputs.iter().flat_map(|(_, x)| x.iter().copied()).collect();
    let logits = Predictor::new(&outcome.net_def, &outcome.weights, outcome.normalizer.clone())?.logits(&flat, inputs.len())?;
    let cases: Vec<Value> = inputs
        .iter()
        .zip(&logits)
        .map(|((name, x), z)| json!({ "name": name, "input": f32s(x), "raw": [f32v(*z)], "score": [f32v(sigmoid_f32(*z))] }))
        .collect();
    let golden = json!({
        "format": "gran-prix.golden",
        "format_version": "1.0.0",
        "weights_sha256": weights_digest,
        "tolerance": { "abs": GOLDEN_TOLERANCE },
        "cases": cases,
    });
    let golden_bytes = pretty(&golden)?;

    let layout: Vec<Value> = outcome
        .layout
        .iter()
        .map(|p| json!({ "name": p.name, "shape": p.shape, "offset": p.offset, "length": p.length }))
        .collect();
    let config_id = TrainConfig::content_id(config_raw)?;
    let impl_id = format!("rust:gp-train@{}", env!("CARGO_PKG_VERSION"));

    let mut model = json!({
        "format": "gran-prix.model-package",
        "format_version": "1.0.0",
        "name": opts.name.clone().unwrap_or_else(|| "gp-train-model".to_string()),
        "task": {
            "name": opts.task_name.clone().unwrap_or_else(|| "binary-classification".to_string()),
            "unit": features.unit,
            "stateless": true,
        },
        "files": {
            "network_def": { "path": "network_def.json", "bytes": net_text.len() },
            "weights": { "path": "weights.f32le", "bytes": weight_bytes.len(), "dtype": "f32le", "count": outcome.weights.len() },
            "golden": { "path": "golden.json", "bytes": golden_bytes.len() },
        },
        "digest": {
            "algorithm": "sha256",
            "network_def": net_digest,
            "weights": weights_digest,
            "golden": sha256_id(&golden_bytes),
        },
        "network": { "input_dim": outcome.net_def.input_dim, "output_dim": outcome.net_def.output_dim(), "param_layout": layout },
        "feature_spec": feature_spec(outcome, features),
        "output_spec": { "activation": "sigmoid", "labels": ["drop", "keep"], "calibration": { "kind": "none" } },
        "thresholds": {
            "accept": f32v(outcome.thresholds.accept),
            "escalate": f32v(outcome.thresholds.escalate),
            "margin": f32v(outcome.thresholds.margin),
        },
        "requires": { "runtime": { "wasm_abi": WASM_ABI }, "layer_types": layer_types(outcome), "extensions": [] },
    });
    let id = model_id(&model)?;
    let report = train_report(outcome, manifest, &config_id, &id);
    let report_bytes = pretty(&report)?;

    let mut headline = Map::new();
    if let Some(m) = &outcome.val_metrics {
        for (k, v) in [("val_f1", m.f1), ("val_precision", m.precision), ("val_recall", m.recall), ("val_accuracy", m.accuracy), ("val_bce", m.bce)] {
            headline.insert(k.to_string(), json!(v));
        }
        if let Some(ap) = m.average_precision {
            headline.insert("val_average_precision".to_string(), json!(ap));
        }
    }
    let cache_key = match &opts.cache_key {
        Some(k) => k.clone(),
        None => train_cache_key(&impl_id, config_raw, &manifest.dataset_id)?,
    };
    let empty_pipeline = sha256_id(b"");
    if let Some(obj) = model.as_object_mut() {
        obj.insert("model_id".to_string(), json!(id));
        // The id is the content hash of the sidecar report. It is not an EvalReport
        // (contract `eval-report`): that artifact comes with the evaluation stage.
        obj.insert("metrics".to_string(), json!({ "eval_report_id": artifact_id(&report)?, "headline": headline }));
        obj.insert(
            "provenance".to_string(),
            json!({
                "produced_by": {
                    "run_id": opts.run_id.clone().unwrap_or_else(|| "local".to_string()),
                    "stage_id": opts.stage_id.clone().unwrap_or_else(|| "train".to_string()),
                    "kind": "train",
                    "impl": impl_id,
                    "params_sha256": config_id,
                    "cache_key": cache_key,
                },
                "inputs": [
                    { "port": "dataset", "artifact_id": manifest.dataset_id },
                    { "port": "train_config", "artifact_id": config_id },
                ],
                "pipeline_spec_id": opts.pipeline_spec_id.clone().unwrap_or(empty_pipeline),
                "tool_versions": { "gp_cli": format!("gp-train {}", env!("CARGO_PKG_VERSION")), "node": "none" },
                "created_at": opts.created_at.clone().unwrap_or_else(now_iso8601),
                "duration_ms": opts.duration_ms.unwrap_or(0),
            }),
        );
    }

    write_bytes(&out_dir.join("network_def.json"), net_text.as_bytes())?;
    write_bytes(&out_dir.join("weights.f32le"), &weight_bytes)?;
    write_bytes(&out_dir.join("golden.json"), &golden_bytes)?;
    write_bytes(&out_dir.join("train_report.json"), &report_bytes)?;
    write_bytes(&out_dir.join("model.json"), &pretty(&model)?)?;
    Ok(PackageSummary { model_id: id, weights_sha256: weights_digest })
}
