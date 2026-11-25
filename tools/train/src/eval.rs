//! `gp-train eval`: scores one split of a dataset with a ModelPackage and reports metrics.
//!
//! The model is loaded through the Rust runtime (`load_package`, which verifies digests and
//! `model_id`), and the raw dataset rows are normalized with the package's own
//! `feature_spec`. The output is a `gp-train.eval` JSON document, NOT the `eval-report`
//! contract (that one is produced by the evaluation stage of the pipeline).

use crate::dataset::{load_split, Manifest, Rows, Split};
use crate::error::Result;
use crate::invalid;
use crate::load::{load_package, Predictor};
use crate::metrics::Metrics;
use crate::loss::sigmoid_f32;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::Path;

fn grouped_metrics(logits: &[f32], rows: &Rows, key_of: impl Fn(usize) -> String, threshold: f32) -> Value {
    let mut buckets: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for i in 0..rows.len() {
        buckets.entry(key_of(i)).or_default().push(i);
    }
    let mut out = Map::new();
    for (key, idx) in buckets {
        let z: Vec<f32> = idx.iter().map(|i| logits[*i]).collect();
        let y: Vec<u8> = idx.iter().map(|i| rows.y[*i]).collect();
        out.insert(key, Metrics::compute(&z, &y, threshold).to_json());
    }
    Value::Object(out)
}

/// Evaluates `split` of `dataset_dir` with the package in `model_dir`.
pub fn evaluate(dataset_dir: &Path, model_dir: &Path, split: Split, with_scores: bool) -> Result<Value> {
    let manifest = Manifest::load(dataset_dir)?;
    let package = load_package(model_dir)?;
    if package.schema_id != manifest.feature_schema_id {
        return Err(invalid!("the model was trained on feature schema {}, the dataset uses {}", package.schema_id, manifest.feature_schema_id));
    }
    if package.dim != manifest.dim {
        return Err(invalid!("the model expects {} features, the dataset has {}", package.dim, manifest.dim));
    }
    let mut rows = load_split(dataset_dir, &manifest, split)?;
    if split == Split::Test {
        if let Some(allowed) = &manifest.filters.test_allowed_sources {
            rows = rows.filtered(0.0, Some(allowed));
        }
    }
    if rows.is_empty() {
        return Err(invalid!("split {} has no rows to evaluate", split.name()));
    }

    let logits = Predictor::from_package(&package)?.logits(&rows.x, rows.len())?;
    let overall = Metrics::compute(&logits, &rows.y, package.accept);
    let stratum = manifest.stratum_of();
    let by_stratum = grouped_metrics(&logits, &rows, |i| stratum.get(rows.group[i].as_str()).copied().unwrap_or("unknown").to_string(), package.accept);
    let by_source = grouped_metrics(&logits, &rows, |i| rows.source[i].clone(), package.accept);

    let mut report = json!({
        "format": "gp-train.eval",
        "format_version": "0.1.0",
        "model_id": package.model["model_id"],
        "dataset_id": manifest.dataset_id,
        "split": split.name(),
        "thresholds": { "accept": f64::from(package.accept), "escalate": f64::from(package.escalate) },
        "overall": overall.to_json(),
        "by_stratum": by_stratum,
        "by_label_source": by_source,
    });
    if with_scores {
        let scores: Vec<Value> = (0..rows.len())
            .map(|i| json!([rows.group[i], rows.unit[i], rows.y[i], f64::from(sigmoid_f32(logits[i]))]))
            .collect();
        report["scores"] = Value::Array(scores);
        report["scores_columns"] = json!(["group", "unit", "y", "score"]);
    }
    Ok(report)
}
