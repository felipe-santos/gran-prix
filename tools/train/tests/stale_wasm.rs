//! `cross-runtime-check.mjs --preflight` must recognise a stale or incompatible WASM build
//! (a dist built before an API change) and explain it, instead of failing deep in the run.
//! The dists here are fakes: a CommonJS module with a `Trainer` class plus a BUILD_INFO.json.

mod common;

use common::repo_root;
use std::path::Path;
use std::process::{Command, Output};

const API: [&str; 10] = [
    "import_weights", "get_weights", "networkDefJson", "paramShapes", "paramTensorCount", "weightCount", "predictBatch", "predictProbsBatch", "predictLogitsBatch", "free",
];

fn node_available() -> bool {
    Command::new("node").arg("--version").output().is_ok()
}

/// The `source_hash` a fresh build of this checkout would stamp (same helper as build-wasm.mjs).
fn current_source_hash() -> String {
    let helper = repo_root().join("scripts/lib/wasm-stamp.mjs");
    let code = format!("import('{}').then((m) => console.log(m.sourceHash('{}').hash))", helper.display(), repo_root().display());
    let out = Command::new("node").args(["-e", &code]).output().expect("node runs");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A fake nodejs dist: `Trainer` has the given methods (and the static constructor); the stamp is optional.
fn fake_dist(dir: &Path, methods: &[&str], source_hash: Option<&str>) {
    let body: String = methods.iter().map(|m| format!("  {m}() {{}}\n")).collect();
    let js = format!("class Trainer {{\n  static fromNetworkDefSeeded() {{}}\n{body}}}\nmodule.exports = {{ Trainer }};\n");
    std::fs::write(dir.join("gran_prix_wasm.js"), js).expect("write js");
    if let Some(h) = source_hash {
        let stamp = serde_json::json!({ "schema": 1, "target": "nodejs", "source_hash": h, "rustc": "fake", "wasm_sha256": "sha256:0" });
        std::fs::write(dir.join("BUILD_INFO.json"), stamp.to_string()).expect("write stamp");
    }
}

fn preflight(dir: &Path) -> Output {
    let script = repo_root().join("tools/train/scripts/cross-runtime-check.mjs");
    Command::new("node").arg(script).arg("--preflight").env("GRAN_PRIX_WASM_NODE", dir).output().expect("node runs")
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).to_string()
}

#[test]
fn a_build_without_a_stamp_is_reported_as_stale() {
    if !node_available() {
        return eprintln!("SKIPPED, node is not installed");
    }
    let tmp = tempfile::tempdir().expect("tmp");
    fake_dist(tmp.path(), &API, None);
    let out = preflight(tmp.path());
    assert_eq!(out.status.code(), Some(3), "{}", stderr(&out));
    let msg = stderr(&out);
    assert!(msg.contains("STALE OR INCOMPATIBLE WASM BUILD") && msg.contains("BUILD_INFO.json is missing") && msg.contains("scripts/build-wasm.mjs"), "{msg}");
}

#[test]
fn a_build_from_other_sources_is_reported_as_stale() {
    if !node_available() {
        return eprintln!("SKIPPED, node is not installed");
    }
    let tmp = tempfile::tempdir().expect("tmp");
    fake_dist(tmp.path(), &API, Some("sha256:0000000000000000000000000000000000000000000000000000000000000000"));
    let out = preflight(tmp.path());
    assert_eq!(out.status.code(), Some(3), "{}", stderr(&out));
    assert!(stderr(&out).contains("built from other Rust sources"), "{}", stderr(&out));
}

#[test]
fn a_build_missing_trainer_methods_is_reported_as_incompatible() {
    if !node_available() {
        return eprintln!("SKIPPED, node is not installed");
    }
    let tmp = tempfile::tempdir().expect("tmp");
    // The stamp matches the checkout, so only the API check can catch this one.
    let old_api: Vec<&str> = API.iter().copied().filter(|m| !["weightCount", "predictLogitsBatch"].contains(m)).collect();
    fake_dist(tmp.path(), &old_api, Some(&current_source_hash()));
    let out = preflight(tmp.path());
    assert_eq!(out.status.code(), Some(3), "{}", stderr(&out));
    assert!(stderr(&out).contains("the Trainer API lacks: weightCount, predictLogitsBatch"), "{}", stderr(&out));
}

#[test]
fn a_fresh_and_compatible_build_passes() {
    if !node_available() {
        return eprintln!("SKIPPED, node is not installed");
    }
    let tmp = tempfile::tempdir().expect("tmp");
    fake_dist(tmp.path(), &API, Some(&current_source_hash()));
    let out = preflight(tmp.path());
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
}
