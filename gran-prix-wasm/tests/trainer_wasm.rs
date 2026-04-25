//! WASM-environment integration tests for the [`Trainer`] bridge.
//!
//! These tests run in a real WASM target (Node.js by default — `wasm-pack
//! test --node`). They exercise the surface area that JavaScript callers
//! actually depend on: batched inference, the canonical
//! `(networkDefJson, weights)` round-trip, and partial freeze semantics
//! used by the backbone+head fine-tuning pattern.
//!
//! The native-Rust unit tests in `gran-prix-wasm/src/diag.rs` only check
//! that core `Trainer` calls succeed; these tests pin down end-to-end
//! behavior across the JS↔WASM boundary.

#![cfg(target_arch = "wasm32")]

use gran_prix_wasm::Trainer;
use wasm_bindgen_test::*;

// Default runner is Node.js — no `wasm_bindgen_test_configure!(run_in_browser)`.

/// Maximum elementwise difference tolerated when asserting that two
/// inference paths produced identical results. This is well above
/// `f32::EPSILON` to absorb any deterministic differences in execution
/// order between `execute()` and `execute_with_order()`, but tight enough
/// that any genuine divergence (a buggy round-trip, a missed param) would
/// blow it up by orders of magnitude.
const PREDICT_EPS: f32 = 1e-6;

/// Asserts that two slices of probabilities are pointwise close.
fn assert_predictions_close(a: &[f32], b: &[f32], context: &str) {
    assert_eq!(
        a.len(),
        b.len(),
        "{}: prediction length mismatch ({} vs {})",
        context,
        a.len(),
        b.len()
    );
    for (i, (&p, &q)) in a.iter().zip(b.iter()).enumerate() {
        let diff = (p - q).abs();
        assert!(
            diff < PREDICT_EPS,
            "{}: sample {} diverged: {} vs {} (|Δ|={:.3e})",
            context,
            i,
            p,
            q,
            diff
        );
    }
}

/// `predict_batch` should produce the same probabilities as calling
/// `predict` once per sample.
#[wasm_bindgen_test]
fn predict_batch_matches_predict_per_sample() {
    let trainer = Trainer::new(2, vec![4]).expect("construct trainer");

    // 5 samples — enough that single-sample and batched paths exercise
    // distinct code (cached topological order, different control flow).
    let inputs: Vec<f32> = vec![
        0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.5, 0.5,
    ];
    let batch = trainer
        .predict_batch(inputs.clone(), 5)
        .expect("predict_batch ok");
    assert_eq!(batch.len(), 5, "binary classifier yields one prob per sample");

    let mut individual = Vec::with_capacity(5);
    for i in 0..5 {
        let row = inputs[i * 2..(i + 1) * 2].to_vec();
        individual.push(trainer.predict(row).expect("predict ok"));
    }

    assert_predictions_close(&batch, &individual, "predict_batch vs predict");
}

/// `predict_batch(inputs, 0)` is a valid no-op and must not panic.
#[wasm_bindgen_test]
fn predict_batch_zero_is_empty() {
    let trainer = Trainer::new(3, vec![4]).expect("construct trainer");
    let out = trainer.predict_batch(vec![], 0).expect("predict_batch(0)");
    assert!(out.is_empty());
}

/// `predict_batch` rejects malformed input lengths instead of silently
/// producing garbage. The exact message is informational, but the call
/// must return `Err`.
#[wasm_bindgen_test]
fn predict_batch_rejects_size_mismatch() {
    let trainer = Trainer::new(3, vec![4]).expect("construct trainer");
    // 5 floats, but trainer wants `batch_size * 3`. 2 samples × 3 = 6, not 5.
    let bad = trainer.predict_batch(vec![1.0, 2.0, 3.0, 4.0, 5.0], 2);
    assert!(bad.is_err(), "size mismatch must be rejected");
}

/// The canonical serialization contract: `(networkDefJson, get_weights)`
/// fully reconstructs trainer behavior. We train a few steps so weights
/// are non-trivial, snapshot predictions, build a fresh trainer from the
/// payload, and assert predictions match.
#[wasm_bindgen_test]
fn round_trip_json_and_weights_preserves_predictions() {
    let trainer = Trainer::new(2, vec![4]).expect("construct trainer");

    // Train for ~80 batched steps over a tiny XOR-ish dataset to perturb
    // weights from random init.
    let inputs: Vec<f32> = vec![0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0];
    let targets: Vec<f32> = vec![0.0, 1.0, 1.0, 0.0];
    for _ in 0..80 {
        let _ = trainer
            .train_batch(inputs.clone(), targets.clone(), 0.05)
            .expect("train_batch ok");
    }

    let predictions_before = trainer
        .predict_batch(inputs.clone(), 4)
        .expect("predict before");

    let net_json = trainer.network_def_json();
    assert!(!net_json.is_empty(), "JSON must not be empty");
    let weights = trainer.get_weights().expect("get_weights ok");
    assert!(!weights.is_empty(), "weights must not be empty");

    drop(trainer);

    let restored = Trainer::from_network_def(&net_json).expect("from_network_def ok");
    restored.import_weights(&weights).expect("import_weights ok");

    let predictions_after = restored
        .predict_batch(inputs, 4)
        .expect("predict after");

    assert_predictions_close(
        &predictions_before,
        &predictions_after,
        "round-trip via (networkDefJson, weights)",
    );
}

/// `paramCount()` matches the structural expectation: each Linear layer
/// contributes exactly two parameter tensors (weight + bias). Activation
/// layers contribute zero. For an MLP `2 → 4 → 1`, the count is 4.
#[wasm_bindgen_test]
fn param_count_matches_architecture() {
    let trainer = Trainer::new(2, vec![4]).expect("construct trainer");
    // Trainer::new builds: Linear(2→4) + Tanh + Linear(4→1)
    // → 2 Linear layers × 2 params = 4 trainable params.
    assert_eq!(trainer.param_count(), 4);

    let trainer2 = Trainer::new(3, vec![8, 4]).expect("construct trainer 2");
    // 3 Linear layers × 2 = 6.
    assert_eq!(trainer2.param_count(), 6);
}

/// Freezing all parameters must prevent any weight from changing during
/// training, even though the optimizer step still runs.
#[wasm_bindgen_test]
fn freeze_all_blocks_weight_updates() {
    let trainer = Trainer::new(2, vec![4]).expect("construct trainer");
    let n = trainer.param_count();
    let all_indices: Vec<usize> = (0..n).collect();
    trainer
        .set_frozen_params(all_indices.clone())
        .expect("freeze all");

    let mask = trainer.frozen_mask();
    assert_eq!(mask.len(), n);
    assert!(mask.iter().all(|&v| v == 1), "all params should be frozen");

    let weights_before = trainer.get_weights().expect("get_weights");

    for _ in 0..20 {
        let _ = trainer
            .train_batch(vec![1.0, 0.0, 0.0, 1.0], vec![1.0, 0.0], 0.1)
            .expect("train_batch");
    }

    let weights_after = trainer.get_weights().expect("get_weights");
    assert_eq!(weights_before.len(), weights_after.len());
    for (i, (a, b)) in weights_before.iter().zip(weights_after.iter()).enumerate() {
        assert!(
            (a - b).abs() < f32::EPSILON,
            "param {} changed despite being frozen ({} → {})",
            i,
            a,
            b
        );
    }
}

/// The backbone+head pattern: freeze every param except the last two
/// (weight + bias of the head Linear), train, and verify only those two
/// moved while the backbone stayed bit-identical.
#[wasm_bindgen_test]
fn backbone_freeze_only_head_trains() {
    let trainer = Trainer::new(2, vec![6, 4]).expect("construct trainer");
    let n = trainer.param_count();
    assert!(n >= 2, "need at least one head layer");

    // Freeze everything except the last two indices (head weight + bias).
    let backbone: Vec<usize> = (0..n - 2).collect();
    trainer
        .set_frozen_params(backbone.clone())
        .expect("freeze backbone");

    let mask = trainer.frozen_mask();
    assert_eq!(mask.len(), n);
    for (i, &m) in mask.iter().enumerate() {
        if i < n - 2 {
            assert_eq!(m, 1, "backbone param {} should be frozen", i);
        } else {
            assert_eq!(m, 0, "head param {} should be trainable", i);
        }
    }

    // Snapshot per-param L1 norms so we can identify *which* params moved.
    let weights_before = trainer.get_weights().expect("get_weights");

    for _ in 0..40 {
        let _ = trainer
            .train_batch(vec![0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0],
                         vec![0.0, 1.0, 1.0, 0.0],
                         0.05)
            .expect("train_batch");
    }

    let weights_after = trainer.get_weights().expect("get_weights");
    assert_eq!(weights_before.len(), weights_after.len());

    // The flat weight vector concatenates params in registration order.
    // We need to know how many scalar values belong to each param to
    // partition the vector. We don't have that boundary directly, but
    // we can detect movement at the *element* level and assert that
    // any movement is concentrated in the suffix.
    //
    // Find the first index where weights differ. Everything before it
    // must belong to a frozen param. Use a generous threshold to avoid
    // tripping on FP noise that doesn't represent a real update.
    let mut first_change: Option<usize> = None;
    for (i, (a, b)) in weights_before.iter().zip(weights_after.iter()).enumerate() {
        if (a - b).abs() > 1e-5 {
            first_change = Some(i);
            break;
        }
    }
    let first_change = first_change.expect("at least one weight should change");

    // Compute the expected boundary: sum of param sizes for the first
    // n-2 params. We can't query per-param shapes from the bridge, but
    // we know the architecture: input_dim=2, hidden=[6,4], output=1.
    //   Linear(2→6): weight 2×6=12, bias 6 → ends at 18
    //   Linear(6→4): weight 6×4=24, bias 4 → ends at 18+28=46
    //   Linear(4→1): weight 4×1=4,  bias 1 → ends at 46+5=51
    // Backbone params (indices 0..n-2 = 0..4) cover offsets 0..46.
    // Head params (indices 4,5) cover offsets 46..51.
    let head_start = 46;
    let total_expected = 51;
    assert_eq!(
        weights_before.len(),
        total_expected,
        "architecture changed — recompute head_start"
    );
    assert!(
        first_change >= head_start,
        "frozen backbone moved: first change at offset {} but head starts at {}",
        first_change,
        head_start
    );

    // And at least one head element actually moved.
    let head_moved = weights_before[head_start..]
        .iter()
        .zip(weights_after[head_start..].iter())
        .any(|(a, b)| (a - b).abs() > 1e-5);
    assert!(head_moved, "head did not train despite being unfrozen");
}

/// `setFrozenParams` validates indices: out-of-bounds → error, and the
/// store is unchanged on failure.
#[wasm_bindgen_test]
fn set_frozen_params_validates_bounds() {
    let trainer = Trainer::new(2, vec![4]).expect("construct trainer");
    let n = trainer.param_count();

    let result = trainer.set_frozen_params(vec![0, n + 99]);
    assert!(result.is_err(), "out-of-bounds index must error");

    let mask = trainer.frozen_mask();
    assert!(
        mask.iter().all(|&m| m == 0),
        "store must be unchanged after a failing setFrozenParams"
    );
}

/// `inputDim` and `outputDim` are honest about what the trainer was
/// constructed with.
#[wasm_bindgen_test]
fn input_output_dims_reported() {
    let trainer = Trainer::new(7, vec![16, 8]).expect("construct trainer");
    assert_eq!(trainer.input_dim(), 7);
    assert_eq!(trainer.output_dim(), 1, "binary classifier always emits one prob");
}
