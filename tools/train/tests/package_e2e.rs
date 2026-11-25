//! End-to-end tests: contracts fixtures, JSON Schema validation of everything gp-train
//! writes, golden reproduction through the core, determinism and the CLI.

mod common;

use common::*;
use gp_train::canonical::sha256_id;
use gp_train::config::TrainConfig;
use gp_train::dataset::{load_split, Manifest, Split};
use gp_train::identity::{model_id, network_def_digest};
use gp_train::load::load_package;
use gp_train::package::PackageOpts;
use gp_train::{run_train, TrainArgs};
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::graph::Node;
use gran_prix::network_def::NetworkDef;
use gran_prix::Tensor;
use serde_json::Value;
use std::path::Path;
use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_gp-train"))
}

fn weights_of(dir: &Path) -> Vec<u8> {
    std::fs::read(dir.join("weights.f32le")).expect("weights.f32le")
}

/// Forward pass of the package through the CORE only (`NetworkDef::from_json` +
/// `import_flat`), with the z-score applied by hand from `model.json`.
fn core_logits(dir: &Path, raw_inputs: &[Vec<f64>]) -> Vec<f32> {
    let model = read_json(&dir.join("model.json"));
    let def = NetworkDef::from_json(&std::fs::read_to_string(dir.join("network_def.json")).expect("network_def")).expect("parses");
    let bytes = weights_of(dir);
    let weights: Vec<f32> = bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let mut net = def.compile(Box::new(CPUBackend)).expect("compiles");
    net.graph.params_mut().import_flat(&weights).expect("imports");
    let z = &model["feature_spec"]["normalization"];
    let num = |v: &Value, i: usize| v[i].as_f64().expect("number");
    raw_inputs
        .iter()
        .map(|x| {
            let xn: Vec<f32> = if z["kind"] == "zscore" {
                (0..x.len()).map(|j| ((x[j] - num(&z["mean"], j)) / (num(&z["std"], j) + z["eps"].as_f64().expect("eps"))) as f32).collect()
            } else {
                x.iter().map(|v| *v as f32).collect()
            };
            if let Some(Node::Input(slot)) = net.graph.nodes_mut().get_mut(net.input_node.0) {
                *slot = Tensor::from_shape_vec(&[1, xn.len()], xn).expect("tensor");
            }
            net.graph.clear_values();
            net.graph.execute(net.output_node).expect("forward").as_slice().expect("slice")[0]
        })
        .collect()
}

fn assert_golden_reproduces(dir: &Path) {
    let golden = read_json(&dir.join("golden.json"));
    let cases = golden["cases"].as_array().expect("cases");
    let tol = golden["tolerance"]["abs"].as_f64().expect("tolerance");
    let inputs: Vec<Vec<f64>> = cases.iter().map(|c| c["input"].as_array().expect("input").iter().map(|v| v.as_f64().expect("n")).collect()).collect();
    let logits = core_logits(dir, &inputs);
    let calibration = read_json(&dir.join("model.json"))["output_spec"]["calibration"]["kind"].clone();
    assert_eq!(calibration, "none", "this check assumes no calibration");
    for (case, z) in cases.iter().zip(logits) {
        let raw = case["raw"][0].as_f64().expect("raw");
        let score = case["score"][0].as_f64().expect("score");
        let p = 1.0 / (1.0 + (-f64::from(z)).exp());
        assert!((raw - f64::from(z)).abs() <= tol, "raw {raw} vs core {z}");
        assert!((score - p).abs() <= tol, "score {score} vs core {p}");
    }
}

#[test]
fn reproduces_the_ids_of_the_committed_fixtures() {
    let pkg = fixtures().join("model-package");
    let model = read_json(&pkg.join("model.json"));
    let d = &model["digest"];
    let net_text = std::fs::read_to_string(pkg.join("network_def.json")).expect("network_def");
    assert_eq!(network_def_digest(&net_text).expect("digest"), d["network_def"].as_str().expect("s"), "digest.network_def (RFC 8785 of the parsed file)");
    assert_eq!(sha256_id(&weights_of(&pkg)), d["weights"].as_str().expect("s"));
    assert_eq!(sha256_id(&std::fs::read(pkg.join("golden.json")).expect("golden")), d["golden"].as_str().expect("s"));
    assert_eq!(model_id(&model).expect("id"), model["model_id"].as_str().expect("s"), "model_id of the TS fixture");

    let (_, raw) = TrainConfig::load(&fixtures().join("train-config.json")).expect("fixture config is accepted");
    assert_eq!(TrainConfig::content_id(&raw).expect("id"), raw["train_config_id"].as_str().expect("s"), "train_config_id");
}

#[test]
fn loads_the_fixture_package_and_its_golden_through_the_core() {
    let pkg = fixtures().join("model-package");
    let loaded = load_package(&pkg).expect("the TS-built fixture package loads and verifies");
    assert_eq!(loaded.dim, 4);
    // The fixture was produced by the WASM trainer; its golden must reproduce here (1e-5).
    let golden = read_json(&pkg.join("golden.json"));
    let inputs: Vec<Vec<f64>> = golden["cases"].as_array().expect("cases").iter().map(|c| c["input"].as_array().expect("i").iter().map(|v| v.as_f64().expect("n")).collect()).collect();
    for (case, z) in golden["cases"].as_array().expect("cases").iter().zip(core_logits(&pkg, &inputs)) {
        assert!((case["raw"][0].as_f64().expect("raw") - f64::from(z)).abs() < 1e-5);
    }
}

#[test]
fn dataset_fixture_passes_the_manifest_checks() {
    let dir = fixtures().join("dataset");
    let manifest = Manifest::load(&dir).expect("manifest");
    for s in [Split::Train, Split::Val, Split::Test] {
        let rows = load_split(&dir, &manifest, s).expect("rows (hash and counts verified)");
        assert_eq!(rows.dim, 4);
        assert!(!rows.is_empty());
    }
}

#[test]
fn trains_on_the_contracts_dataset_fixture_and_emits_a_schema_valid_package() {
    let tmp = tempfile::tempdir().expect("tmp");
    let out = tmp.path().join("model");
    let args = TrainArgs {
        dataset: fixtures().join("dataset"),
        config: fixtures().join("train-config.json"),
        out: out.clone(),
        seed: None,
        feature_schema: Some(fixtures().join("feature-schema.json")),
        opts: PackageOpts { created_at: Some("2026-11-25T12:00:00Z".into()), ..PackageOpts::default() },
    };
    let (summary, outcome) = run_train(&args).expect("trains");
    assert!(outcome.history.len() <= 30);

    let model = read_json(&out.join("model.json"));
    assert_valid("model-package", &model);
    assert_valid("golden", &read_json(&out.join("golden.json")));
    assert_valid("network-def", &read_json(&out.join("network_def.json")));
    assert_eq!(model["model_id"], summary.model_id.as_str());
    assert_eq!(model["feature_spec"]["names"][0], "log_text_len", "names come from the feature schema");
    assert_eq!(model["feature_spec"]["schema_id"], read_json(&fixtures().join("feature-schema.json"))["schema_id"]);
    assert_eq!(model["provenance"]["created_at"], "2026-11-25T12:00:00Z");
    let (_, raw) = TrainConfig::load(&fixtures().join("train-config.json")).expect("config");
    assert_eq!(model["provenance"]["produced_by"]["params_sha256"], raw["train_config_id"], "params_sha256 is the contract id of the config (seed unchanged)");

    load_package(&out).expect("the package verifies on load (digests, model_id, layout)");
    assert_golden_reproduces(&out);
}

#[test]
fn synthetic_end_to_end_through_the_cli_is_deterministic_and_correct() {
    let tmp = tempfile::tempdir().expect("tmp");
    let data = tmp.path().join("data");
    write_synthetic_dataset(&data, [480, 160, 160], 7);
    let cfg = tmp.path().join("train.json");
    write_config(&cfg, |_| {});

    let train = |out: &Path, extra: &[&str]| {
        let output = bin()
            .args(["train", "--dataset"])
            .arg(&data)
            .arg("--config")
            .arg(&cfg)
            .arg("--out")
            .arg(out)
            .args(["--created-at", "2026-11-25T12:00:00Z"])
            .args(extra)
            .output()
            .expect("runs");
        assert!(output.status.success(), "gp-train failed: {}", String::from_utf8_lossy(&output.stderr));
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        stdout.lines().find_map(|l| l.strip_prefix("weights_sha256")).map(|s| s.trim().to_string()).expect("weights_sha256 line")
    };

    let (a, b, c) = (tmp.path().join("a"), tmp.path().join("b"), tmp.path().join("c"));
    let sha_a = train(&a, &[]);
    let sha_b = train(&b, &[]);
    let sha_c = train(&c, &["--seed", "43"]);
    println!("determinism: seed 42 twice -> {sha_a} / {sha_b}; seed 43 -> {sha_c}");
    assert_eq!(sha_a, sha_b, "same dataset + config + seed -> same weights sha256");
    assert_eq!(weights_of(&a), weights_of(&b));
    assert_eq!(sha_a, sha256_id(&weights_of(&a)));
    assert_ne!(sha_a, sha_c, "another seed gives other weights");
    let without_duration = |dir: &Path| {
        let mut m = read_json(&dir.join("model.json"));
        m["provenance"]["duration_ms"] = 0.into();
        m
    };
    assert_eq!(without_duration(&a), without_duration(&b), "with a fixed created_at the whole model.json is identical (duration aside)");
    assert_eq!(std::fs::read(a.join("golden.json")).expect("golden"), std::fs::read(b.join("golden.json")).expect("golden"));
}

#[test]
fn model_is_good_normalization_is_fit_on_train_and_package_is_valid() {
    let tmp = tempfile::tempdir().expect("tmp");
    let data = tmp.path().join("data");
    write_synthetic_dataset(&data, [480, 160, 160], 7);
    let cfg = tmp.path().join("train.json");
    write_config(&cfg, |_| {});
    let out = tmp.path().join("m");
    let args = TrainArgs { dataset: data.clone(), config: cfg, out: out.clone(), seed: None, feature_schema: None, opts: PackageOpts::default() };
    let (_, outcome) = run_train(&args).expect("trains");

    let model = read_json(&out.join("model.json"));
    assert_valid("model-package", &model);
    assert_valid("golden", &read_json(&out.join("golden.json")));
    load_package(&out).expect("verifies");
    assert_golden_reproduces(&out);

    // z-score parameters come from the train split only.
    let manifest = Manifest::load(&data).expect("manifest");
    let train_rows = load_split(&data, &manifest, Split::Train).expect("rows");
    let val_rows = load_split(&data, &manifest, Split::Val).expect("rows");
    let mean = |rows: &gp_train::dataset::Rows, j: usize| (0..rows.len()).map(|i| f64::from(rows.row(i)[j])).sum::<f64>() / rows.len() as f64;
    let stored = model["feature_spec"]["normalization"]["mean"][0].as_f64().expect("mean");
    assert!((stored - mean(&train_rows, 0)).abs() < 1e-6, "stored mean {stored} vs train mean {}", mean(&train_rows, 0));
    assert!((stored - mean(&val_rows, 0)).abs() > 1e-4, "must differ from the val mean (else the test proves nothing)");
    assert_eq!(model["feature_spec"]["normalization"]["std"][5], 1.0, "constant feature: std stored as 1");
    assert_eq!(model["feature_spec"]["ood"]["lo"].as_array().map(Vec::len), Some(6));

    // Thresholds and metrics.
    let th = &model["thresholds"];
    let (accept, escalate) = (th["accept"].as_f64().expect("a"), th["escalate"].as_f64().expect("e"));
    assert!(0.0 < accept && accept < 1.0 && escalate <= accept);
    assert!(outcome.val_metrics.as_ref().expect("val").f1 > 0.7, "val F1 {:?}", outcome.val_metrics.as_ref().map(|m| m.f1));
    assert!(model["metrics"]["headline"]["val_f1"].as_f64().expect("f1") > 0.7);

    // eval through the CLI on the test split.
    let report = tmp.path().join("eval.json");
    let status = bin().args(["eval", "--dataset"]).arg(&data).arg("--model").arg(&out).args(["--split", "test", "--with-scores", "--out"]).arg(&report).status().expect("runs");
    assert!(status.success());
    let report = read_json(&report);
    assert!(report["overall"]["f1"].as_f64().expect("f1") > 0.7, "test F1 {}", report["overall"]["f1"]);
    assert_eq!(report["overall"]["n"], 160);
    assert_eq!(report["model_id"], model["model_id"]);
    assert!(report["by_stratum"]["article"].is_object() && report["by_stratum"]["docs"].is_object());
    assert_eq!(report["scores"].as_array().map(Vec::len), Some(160));
}

#[test]
fn refuses_corrupt_or_unsupported_inputs() {
    let tmp = tempfile::tempdir().expect("tmp");
    let data = tmp.path().join("data");
    write_synthetic_dataset(&data, [200, 80, 80], 3);
    let cfg = tmp.path().join("train.json");
    write_config(&cfg, |c| c["epochs"] = 3.into());
    let out = tmp.path().join("m");
    let run = |data: &Path, cfg: &Path, out: &Path| bin().args(["train", "--dataset"]).arg(data).arg("--config").arg(cfg).arg("--out").arg(out).output().expect("runs");

    // A flipped byte in a split breaks the manifest hash.
    let tampered = tmp.path().join("tampered");
    write_synthetic_dataset(&tampered, [200, 80, 80], 3);
    let mut rows = std::fs::read_to_string(tampered.join("train.jsonl")).expect("rows");
    rows.insert(0, ' ');
    std::fs::write(tampered.join("train.jsonl"), rows).expect("write");
    let r = run(&tampered, &cfg, &out);
    assert!(!r.status.success() && String::from_utf8_lossy(&r.stderr).contains("sha256"), "{}", String::from_utf8_lossy(&r.stderr));

    // Unsupported config surfaces as an error, not as a silent fallback.
    let bad = tmp.path().join("bad.json");
    write_config(&bad, |c| c["init_from"] = serde_json::json!({ "model_id": sha256_id(b"x") }));
    let r = run(&data, &bad, &out);
    assert!(!r.status.success() && String::from_utf8_lossy(&r.stderr).contains("init_from"));

    // A package whose weights changed no longer loads.
    let ok = run(&data, &cfg, &out);
    assert!(ok.status.success(), "{}", String::from_utf8_lossy(&ok.stderr));
    let mut w = weights_of(&out);
    w[0] ^= 0x01;
    std::fs::write(out.join("weights.f32le"), w).expect("write");
    assert!(load_package(&out).expect_err("tampered weights").to_string().contains("digest.weights"));
    let r = bin().args(["eval", "--dataset"]).arg(&data).arg("--model").arg(&out).args(["--split", "test", "--out"]).arg(tmp.path().join("e.json")).output().expect("runs");
    assert!(!r.status.success());
}

/// Cross-runtime parity: the package must produce its golden in the WASM Trainer and in
/// `@gran-prix/infer-ts`. Skipped (with a message) when the JS side is not built; set
/// `GP_TRAIN_REQUIRE_NODE=1` to make the absence a failure (CI).
#[test]
fn golden_reproduces_in_wasm_and_infer_ts() {
    let root = repo_root();
    let wasm = root.join("packages/wasm/dist/node/gran_prix_wasm.js");
    let infer = root.join("packages/infer-ts/dist/index.js");
    let script = root.join("tools/train/scripts/cross-runtime-check.mjs");
    let missing = [(&wasm, "node scripts/build-wasm.mjs --target both --web-out packages/wasm/dist/web --node-out packages/wasm/dist/node"), (&infer, "pnpm install && pnpm --filter @gran-prix/infer-ts build")]
        .into_iter()
        .filter(|(p, _)| !p.exists())
        .map(|(p, how)| format!("{} (build: {how})", p.display()))
        .collect::<Vec<_>>();
    if !missing.is_empty() || Command::new("node").arg("--version").output().is_err() {
        assert!(std::env::var("GP_TRAIN_REQUIRE_NODE").is_err(), "cross-runtime prerequisites missing: {missing:?}");
        eprintln!("SKIPPED cross-runtime check, missing: {missing:?}");
        return;
    }
    let tmp = tempfile::tempdir().expect("tmp");
    let data = tmp.path().join("data");
    write_synthetic_dataset(&data, [480, 160, 160], 11);
    let cfg = tmp.path().join("train.json");
    write_config(&cfg, |c| c["network"]["hidden"] = serde_json::json!([16, 8]));
    let out = tmp.path().join("m");
    let args = TrainArgs { dataset: data, config: cfg, out: out.clone(), seed: None, feature_schema: None, opts: PackageOpts::default() };
    run_train(&args).expect("trains");

    let result = Command::new("node").arg(&script).arg(&out).output().expect("node runs");
    let stdout = String::from_utf8_lossy(&result.stdout);
    println!("{stdout}");
    assert!(result.status.success(), "cross-runtime check failed:\n{stdout}\n{}", String::from_utf8_lossy(&result.stderr));
}
