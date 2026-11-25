//! Identities of a ModelPackage (README of `packages/contracts`, "ID rules"):
//! `digest.network_def`, `model_id`, the stage cache key, and the timestamp format of the
//! provenance.

use crate::canonical::{artifact_id, canonical_json, sha256_id};
use crate::error::{parse_json, Result};
use crate::invalid;
use serde_json::{json, Value};

/// `digest.network_def`: sha256 of the canonical JSON of the PARSED `network_def.json`
/// (insensitive to whitespace and key order).
pub fn network_def_digest(network_def_text: &str) -> Result<String> {
    let parsed: Value = parse_json(network_def_text, "network_def.json")?;
    artifact_id(&parsed)
}

/// `modelId(model.json)` (ADR-003): the behavior hash.
///
/// ```text
/// artifactId({ v: "gran-prix.model-id/1", digest: { network_def, weights },
///              task, feature_spec, output_spec, thresholds, requires })
/// ```
pub fn model_id(model: &Value) -> Result<String> {
    let field = |name: &str| model.get(name).ok_or_else(|| invalid!("model.json has no \"{name}\""));
    let digest = field("digest")?;
    let part = |name: &str| digest.get(name).ok_or_else(|| invalid!("model.json digest has no \"{name}\""));
    artifact_id(&json!({
        "v": "gran-prix.model-id/1",
        "digest": { "network_def": part("network_def")?, "weights": part("weights")? },
        "task": field("task")?,
        "feature_spec": field("feature_spec")?,
        "output_spec": field("output_spec")?,
        "thresholds": field("thresholds")?,
        "requires": field("requires")?,
    }))
}

/// `stageCacheKey` for a training stage with a single `dataset` input and no wasm binary.
pub fn train_cache_key(impl_id: &str, params: &Value, dataset_id: &str) -> Result<String> {
    artifact_id(&json!({
        "v": "gran-prix.stage-cache-key/1",
        "kind": "train",
        "impl": impl_id,
        "params": params,
        "inputs": { "dataset": dataset_id },
        "env": {},
    }))
}

/// Canonical text of a document, as hashed by `sha256_id(canonical.as_bytes())`.
pub fn canonical_digest(value: &Value) -> Result<String> {
    Ok(sha256_id(canonical_json(value)?.as_bytes()))
}

/// RFC 3339 UTC timestamp (`2026-11-25T12:00:00Z`) from Unix seconds.
pub fn iso8601_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil-from-days (Howard Hinnant's algorithm), valid for the whole u64 range we use.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// Current time as an RFC 3339 UTC string.
pub fn now_iso8601() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    iso8601_utc(secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_format_known_instants() {
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_utc(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(iso8601_utc(1_764_072_000), "2025-11-25T12:00:00Z");
        assert_eq!(iso8601_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso8601_utc(4_102_444_800), "2100-01-01T00:00:00Z");
    }

    #[test]
    fn network_def_digest_ignores_whitespace_and_key_order() {
        let a = r#"{"input_dim":2,"layers":[{"type":"linear","in_features":2,"out_features":1}]}"#;
        let b = "{\n  \"layers\": [ { \"out_features\": 1, \"in_features\": 2, \"type\": \"linear\" } ],\n  \"input_dim\": 2\n}\n";
        assert_eq!(network_def_digest(a).expect("ok"), network_def_digest(b).expect("ok"));
    }

    #[test]
    fn model_id_changes_with_behavior_but_not_with_metrics() {
        let base = json!({
            "digest": {"network_def": "sha256:a", "weights": "sha256:b", "golden": "sha256:c"},
            "task": {}, "feature_spec": {}, "output_spec": {}, "thresholds": {"accept": 0.5}, "requires": {},
            "metrics": {"headline": {"f1": 0.5}}, "name": "x",
        });
        let mut other_metrics = base.clone();
        other_metrics["metrics"]["headline"]["f1"] = json!(0.9);
        other_metrics["name"] = json!("y");
        other_metrics["digest"]["golden"] = json!("sha256:d");
        let mut other_threshold = base.clone();
        other_threshold["thresholds"]["accept"] = json!(0.6);
        assert_eq!(model_id(&base).expect("id"), model_id(&other_metrics).expect("id"));
        assert_ne!(model_id(&base).expect("id"), model_id(&other_threshold).expect("id"));
        assert!(model_id(&json!({})).is_err());
    }
}
