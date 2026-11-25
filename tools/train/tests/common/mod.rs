//! Shared helpers of the integration tests: contract paths, JSON Schema validation against
//! `packages/contracts/schemas` (the source of truth), and a synthetic dataset generator.
#![allow(dead_code)]

use gp_train::canonical::sha256_id;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn contracts() -> PathBuf {
    repo_root().join("packages/contracts")
}

pub fn fixtures() -> PathBuf {
    contracts().join("fixtures/valid")
}

pub fn read_json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("invalid JSON in {}: {e}", path.display()))
}

/// Errors of `instance` against `schemas/<contract>.schema.json` (empty = valid).
pub fn schema_errors(contract: &str, instance: &Value) -> Vec<String> {
    let schema = read_json(&contracts().join(format!("schemas/{contract}.schema.json")));
    let validator = jsonschema::validator_for(&schema).unwrap_or_else(|e| panic!("schema {contract} does not compile: {e}"));
    validator.iter_errors(instance).map(|e| format!("{}: {e}", e.instance_path())).collect()
}

pub fn assert_valid(contract: &str, instance: &Value) {
    let errors = schema_errors(contract, instance);
    assert!(errors.is_empty(), "{contract} violates its JSON Schema:\n{}", errors.join("\n"));
}

/// Deterministic generator (LCG), uniform in [-0.5, 0.5).
pub struct Lcg(u64);

impl Lcg {
    pub fn new(seed: u64) -> Lcg {
        Lcg(seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407))
    }

    pub fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 40) as f32 / (1u64 << 24) as f32) - 0.5
    }
}

fn f32_json(x: f32) -> Value {
    json!(f64::from(x))
}

/// Writes a synthetic dataset directory: 6 features (feature 5 is constant), ~25% positives,
/// label noise-free but with overlapping blobs, groups spread over the splits.
/// Returns (dataset dir contents written, manifest).
pub fn write_synthetic_dataset(dir: &Path, rows_per_split: [usize; 3], seed: u64) -> Value {
    std::fs::create_dir_all(dir).expect("mkdir");
    let dim = 6;
    let names = ["train", "val", "test"];
    let sources = ["human", "llm", "heuristic"];
    let mut rng = Lcg::new(seed);
    let mut files = serde_json::Map::new();
    let mut groups = Vec::new();
    for (si, split) in names.iter().enumerate() {
        let n = rows_per_split[si];
        let mut text = String::new();
        let mut pos = 0;
        for i in 0..n {
            let y = u8::from(i % 4 == 0);
            pos += usize::from(y);
            let c = if y == 1 { 1.0f32 } else { -1.0 };
            let x: Vec<Value> = [
                c * 0.9 + rng.next() * 2.6,
                c * 0.5 + rng.next() * 2.6,
                rng.next() * 3.0,
                50.0 + c * 4.0 + rng.next() * 30.0,
                (c * 0.1 + rng.next()).clamp(-0.5, 0.5) + 0.5,
                7.0,
            ]
            .into_iter()
            .map(f32_json)
            .collect();
            let row = json!({ "g": format!("g{si}_{}", i % 3), "u": i, "x": x, "y": y, "c": 0.9, "s": sources[i % 3] });
            text.push_str(&serde_json::to_string(&row).expect("row"));
            text.push('\n');
        }
        std::fs::write(dir.join(format!("{split}.jsonl")), &text).expect("write rows");
        files.insert(
            split.to_string(),
            json!({ "path": format!("{split}.jsonl"), "sha256": sha256_id(text.as_bytes()), "bytes": text.len(), "media_type": "application/x-ndjson", "rows": n, "pos_rate": pos as f64 / n.max(1) as f64 }),
        );
        for g in 0..3 {
            let in_group = (0..n).filter(|i| i % 3 == g).count();
            let pos_in_group = (0..n).filter(|i| i % 3 == g && i % 4 == 0).count();
            groups.push(json!({ "group_id": format!("g{si}_{g}"), "group_key": format!("site{si}{g}.example"), "stratum": if g == 0 { "article" } else { "docs" }, "split": split, "bucket": si * 40 + g, "n_rows": in_group, "n_pos": pos_in_group }));
        }
    }
    let manifest = json!({
        "format": "gran-prix.dataset-manifest",
        "format_version": "1.0.0",
        "dataset_id": sha256_id(b"synthetic-dataset"),
        "feature_schema_id": sha256_id(b"synthetic-feature-schema"),
        "dim": dim,
        "label_space": { "kind": "binary", "classes": ["drop", "keep"] },
        "sources": [],
        "filters": { "drop_unlabeled": true, "min_confidence": 0.5, "allowed_sources": ["human", "llm", "heuristic"], "dedupe": "none" },
        "groups": groups,
        "split": { "scheme": "hash-bucket-v1", "group_by": "group_key", "salt": "synthetic", "n_buckets": 100,
                   "ranges": { "train": [0, 70], "val": [70, 85], "test": [85, 100] }, "overrides": {} },
        "files": files,
        "stats": { "by_split": {}, "by_stratum": {} },
    });
    std::fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&manifest).expect("manifest")).expect("write manifest");
    manifest
}

/// A valid TrainConfig as JSON text; `patch` edits the document before it is written.
pub fn write_config(path: &Path, patch: impl FnOnce(&mut Value)) -> Value {
    let mut cfg = json!({
        "format": "gran-prix.train-config",
        "format_version": "1.0.0",
        "seed": 42,
        "network": { "kind": "mlp", "hidden": [8], "activation": "relu", "input_dim": "auto" },
        "loss": "bce_logits",
        "optimizer": { "kind": "adam", "lr": 0.02 },
        "lr_schedule": { "kind": "cosine", "min_lr": 0.001 },
        "epochs": 25,
        "batch_size": 32,
        "data": { "min_confidence": 0.5, "allowed_sources": ["human", "llm", "heuristic"], "class_balance": { "strategy": "pos_weight", "pos_weight": 2.0 } },
        "normalization": { "kind": "zscore", "fit_on": "train" },
        "early_stopping": { "metric": "val_loss", "patience": 6, "min_delta": 0.0001 },
        "threshold": { "strategy": "max_f1_on_val" },
        "runtime": { "engine": "gp-train" },
    });
    patch(&mut cfg);
    std::fs::write(path, serde_json::to_string_pretty(&cfg).expect("config")).expect("write config");
    cfg
}
