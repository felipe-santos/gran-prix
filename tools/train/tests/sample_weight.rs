//! Per-row sample weight (`sample_weight: "row"`) and the proof that leaving it off changes nothing.
//!
//! The pinned digests below were taken from the trainer BEFORE the weight existed (commit 4bc18e6),
//! on the synthetic dataset of `common`. They are the byte-for-byte contract of the unweighted path:
//! if one of them moves, the default path is no longer the old one.

mod common;

use common::*;
use gp_train::package::PackageOpts;
use gp_train::{run_train, TrainArgs};
use serde_json::{json, Value};
use std::path::Path;

fn opts() -> PackageOpts {
    PackageOpts {
        created_at: Some("2026-01-01T00:00:00Z".into()),
        run_id: Some("run-sw".into()),
        stage_id: Some("train".into()),
        cache_key: Some(format!("sha256:{}", "0".repeat(64))),
        pipeline_spec_id: Some(format!("sha256:{}", "1".repeat(64))),
        duration_ms: Some(0),
        ..PackageOpts::default()
    }
}

/// Trains `patch(config)` on the dataset in `data` and returns (sha256 of weights.f32le, model_id).
fn train_digest(data: &Path, work: &Path, name: &str, patch: impl FnOnce(&mut Value)) -> (String, String) {
    let cfg = work.join(format!("{name}.json"));
    write_config(&cfg, patch);
    let out = work.join(format!("{name}-out"));
    let args = TrainArgs { dataset: data.to_path_buf(), config: cfg, out, seed: None, feature_schema: None, opts: opts() };
    let (summary, _) = run_train(&args).unwrap_or_else(|e| panic!("{name}: {e}"));
    (summary.weights_sha256, summary.model_id)
}

fn synthetic(work: &Path) -> std::path::PathBuf {
    let data = work.join("data");
    write_synthetic_dataset(&data, [240, 80, 80], 7);
    data
}

fn cases() -> Vec<(&'static str, Box<dyn Fn(&mut Value)>)> {
    vec![
        ("default", Box::new(|_: &mut Value| {})),
        (
            "none-no-es",
            Box::new(|c: &mut Value| {
                c["data"]["class_balance"] = json!({ "strategy": "none" });
                c.as_object_mut().expect("object").remove("early_stopping");
            }),
        ),
        (
            "oversample",
            Box::new(|c: &mut Value| {
                c["data"]["class_balance"] = json!({ "strategy": "oversample_pos", "target_pos_rate": 0.5 });
            }),
        ),
        (
            "undersample-fixed",
            Box::new(|c: &mut Value| {
                c["data"]["class_balance"] = json!({ "strategy": "undersample_neg" });
                c["threshold"] = json!({ "strategy": "fixed", "value": 0.4 });
                c["network"] = json!({ "kind": "mlp", "hidden": [6, 4], "activation": "tanh", "input_dim": "auto" });
            }),
        ),
    ]
}

/// (case, sha256 of weights.f32le, model_id), taken from the code before the weight was added, on the machine where
/// the change was made. Trained weights are bit-reproducible on one platform, not across platforms: `f32::exp` and
/// friends come from the system libm, whose results (and FMA variants picked per CPU) can differ in the last bit,
/// and training amplifies that. So the pinned comparison runs only where `GP_TRAIN_PINNED_PLATFORM=1` says the
/// platform is the one the hashes came from; everywhere else the portable checks below (unit weights == no weights,
/// weights ignored when off, byte for byte within one run) carry the bit-identity claim.
const PINNED: &[(&str, &str, &str)] = &[
    ("default", "sha256:2b56b33662b16b946d69224861519a646b8a4811b948aacf903066c1938a8601", "sha256:ab14cb9945f24a6b70889fa558e7ab11436c2d8186a821dbda99482d0f66f7bd"),
    ("none-no-es", "sha256:34edf36fe421ed214100189a081aed324ee73ab9b9f3bd754c440d7a1744745b", "sha256:82e07dbd82a063919dc8b09bd9f1b81c60f4aae2efd3781037d37500eb23eb3e"),
    ("oversample", "sha256:6380d3d4e0807c8a26067f22afd727d546b326e0a1286bf9729dba2874dc9889", "sha256:3b26fa2f494c47f4e06159316c3d33d2060318930a8abf4285e66b434f2dda84"),
    ("undersample-fixed", "sha256:12dde7607115d1dafa24a58e6452f313f642569daf80265f1262b266fe23211e", "sha256:54e289e036e9d5d9e64f5d3e629a1e24a25af4aef9380c9a0df19fe72d3d990f"),
];

#[test]
fn the_unweighted_path_is_bit_identical_to_the_trainer_before_the_weight_existed() {
    if std::env::var("GP_TRAIN_PINNED_PLATFORM").is_err() && std::env::var("SW_PRINT").is_err() {
        eprintln!("skipped: the pinned hashes are platform-specific (set GP_TRAIN_PINNED_PLATFORM=1 on the machine they came from)");
        return;
    }
    let tmp = tempfile::tempdir().expect("tmp");
    let data = synthetic(tmp.path());
    for (name, patch) in cases() {
        let (w, m) = train_digest(&data, tmp.path(), name, patch);
        if std::env::var("SW_PRINT").is_ok() {
            println!("PIN {name} {w} {m}");
            continue;
        }
        let (_, pw, pm) = PINNED.iter().find(|p| p.0 == name).expect("pinned");
        assert_eq!(&w, pw, "{name}: weights.f32le moved");
        assert_eq!(&m, pm, "{name}: model_id moved");
    }
}

/// Adds `w = weight(split, row index, row)` to every row of the dataset in `dir` and declares
/// `row_weight` in the manifest (with the new hashes) when `declare` is set.
fn add_weights(dir: &Path, declare: bool, weight: impl Fn(&str, usize, &Value) -> Option<u64>) {
    let mp = dir.join("manifest.json");
    let mut manifest = read_json(&mp);
    for split in ["train", "val", "test"] {
        let path = dir.join(format!("{split}.jsonl"));
        let text = std::fs::read_to_string(&path).expect("rows");
        let mut out = String::new();
        for (i, line) in text.lines().enumerate() {
            let mut row: Value = serde_json::from_str(line).expect("row");
            if let Some(w) = weight(split, i, &row) {
                row["w"] = json!(w);
            }
            out.push_str(&serde_json::to_string(&row).expect("row"));
            out.push('\n');
        }
        std::fs::write(&path, &out).expect("write");
        manifest["files"][split]["sha256"] = json!(gp_train::canonical::sha256_id(out.as_bytes()));
        manifest["files"][split]["bytes"] = json!(out.len());
    }
    if declare {
        manifest["row_weight"] = json!("own_text_chars");
    }
    std::fs::write(&mp, serde_json::to_string_pretty(&manifest).expect("manifest")).expect("write manifest");
}

fn weighted_dataset(work: &Path, name: &str, weight: impl Fn(&str, usize, &Value) -> Option<u64>) -> std::path::PathBuf {
    let data = work.join(name);
    write_synthetic_dataset(&data, [240, 80, 80], 7);
    add_weights(&data, true, weight);
    data
}

fn row_patch(c: &mut Value) {
    c["format_version"] = json!("1.1.0");
    c["sample_weight"] = json!("row");
}

fn weights_of_run(data: &Path, work: &Path, name: &str, patch: impl FnOnce(&mut Value)) -> Vec<u8> {
    let cfg = work.join(format!("{name}.json"));
    write_config(&cfg, patch);
    let out = work.join(format!("{name}-out"));
    let args = TrainArgs { dataset: data.to_path_buf(), config: cfg, out: out.clone(), seed: None, feature_schema: None, opts: opts() };
    run_train(&args).unwrap_or_else(|e| panic!("{name}: {e}"));
    std::fs::read(out.join("weights.f32le")).expect("weights")
}

#[test]
fn row_weight_trains_end_to_end_and_the_outputs_validate() {
    let tmp = tempfile::tempdir().expect("tmp");
    // A skewed integer weight: every fifth row weighs 41, the others 1.
    let data = weighted_dataset(tmp.path(), "wdata", |_, i, _| Some(if i % 5 == 0 { 41 } else { 1 }));
    let cfg = tmp.path().join("row.json");
    let doc = write_config(&cfg, row_patch);
    assert_valid("train-config", &doc);
    let out = tmp.path().join("row-out");
    let args = TrainArgs { dataset: data.clone(), config: cfg, out: out.clone(), seed: None, feature_schema: None, opts: opts() };
    run_train(&args).expect("trains with row weights");
    assert_valid("model-package", &read_json(&out.join("model.json")));
    let report = read_json(&out.join("train_report.json"));
    assert_eq!(report["sample_weight"], "row");
    let weighted = std::fs::read(out.join("weights.f32le")).expect("weights");
    let plain = weights_of_run(&data, tmp.path(), "none", |_| {});
    assert_ne!(weighted, plain, "the weight must change the fit");
}

#[test]
fn a_dataset_with_weights_trains_like_one_without_when_the_weight_is_off() {
    let tmp = tempfile::tempdir().expect("tmp");
    let plain_data = synthetic(tmp.path());
    let w_data = weighted_dataset(tmp.path(), "wdata", |_, i, _| Some(1 + i as u64));
    let a = weights_of_run(&plain_data, tmp.path(), "a", |_| {});
    let b = weights_of_run(&w_data, tmp.path(), "b", |_| {});
    assert_eq!(a, b, "w on the rows is inert unless sample_weight is row");
}

#[test]
fn unit_row_weights_reproduce_the_unweighted_fit_byte_for_byte() {
    let tmp = tempfile::tempdir().expect("tmp");
    let plain_data = synthetic(tmp.path());
    let ones = weighted_dataset(tmp.path(), "ones", |_, _, _| Some(1));
    let a = weights_of_run(&plain_data, tmp.path(), "a", |_| {});
    let b = weights_of_run(&ones, tmp.path(), "b", row_patch);
    assert_eq!(a, b);
}

#[test]
fn row_weight_without_row_weights_in_the_dataset_fails_loudly() {
    let tmp = tempfile::tempdir().expect("tmp");
    let data = synthetic(tmp.path());
    let cfg = tmp.path().join("row.json");
    write_config(&cfg, row_patch);
    let args = TrainArgs { dataset: data, config: cfg, out: tmp.path().join("out"), seed: None, feature_schema: None, opts: opts() };
    let err = run_train(&args).expect_err("must refuse").to_string();
    assert!(err.contains("sample_weight") && err.contains("row_weight"), "{err}");
    assert!(!tmp.path().join("out").join("model.json").exists(), "nothing is written");
}

#[test]
fn a_manifest_that_declares_row_weight_needs_w_in_every_row() {
    let tmp = tempfile::tempdir().expect("tmp");
    let data = tmp.path().join("holes");
    write_synthetic_dataset(&data, [240, 80, 80], 7);
    add_weights(&data, true, |split, i, _| (!(split == "train" && i == 3)).then_some(5));
    let cfg = tmp.path().join("none.json");
    write_config(&cfg, |_| {});
    let args = TrainArgs { dataset: data, config: cfg, out: tmp.path().join("out"), seed: None, feature_schema: None, opts: opts() };
    let err = run_train(&args).expect_err("a row without w").to_string();
    assert!(err.contains("train.jsonl line 4") && err.contains("no w"), "{err}");
}

#[test]
fn the_cli_refuses_row_weight_on_an_unweighted_dataset() {
    let tmp = tempfile::tempdir().expect("tmp");
    let data = synthetic(tmp.path());
    let cfg = tmp.path().join("row.json");
    write_config(&cfg, row_patch);
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_gp-train"))
        .args(["train", "--dataset"])
        .arg(&data)
        .arg("--config")
        .arg(&cfg)
        .arg("--out")
        .arg(tmp.path().join("out"))
        .output()
        .expect("runs");
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("row_weight"));
}
