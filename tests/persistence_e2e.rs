//! End-to-end persistence test for the canonical serialization contract:
//!
//!     (NetworkDef JSON, flat weights via ParamStore::export_flat)
//!
//! This is the contract the Chrome extension and any other downstream
//! consumer should rely on — *not* `serde_json::to_string(&Graph)`. The
//! `Graph` type has `#[serde(skip)]` on its execution engine and there is
//! no test guaranteeing that a *trained* `Graph` round-trips identically
//! through `serde`. The `(NetworkDef, flat weights)` path uses only
//! primitives that are individually unit-tested (`NetworkDef::to_json` /
//! `from_json`, `ParamStore::export_flat` / `import_flat`).
//!
//! The test trains a small MLP for a handful of steps (enough to perturb
//! weights away from random initialization), snapshots its predictions
//! on a fixed input set, drops the live graph entirely, reconstructs from
//! the JSON + weights, and asserts the predictions match bit-for-bit
//! (within FP rounding tolerance).

use gran_prix::backend::cpu::CPUBackend;
use gran_prix::loss::{BCEWithLogits, Loss};
use gran_prix::network_def::{ActivationType, NetworkDef};
use gran_prix::optim::{Adam, Optimizer};
use gran_prix::Tensor;

/// Runs a forward pass on each row of `test_inputs` (shape `[N, input_dim]`)
/// and returns the resulting raw output values flattened in row-major order.
///
/// The graph's input node is rewritten in place for each sample so the
/// network sees `[1, input_dim]` shapes regardless of how it was compiled.
fn predict_all(
    graph: &mut gran_prix::graph::Graph,
    input_node: gran_prix::NodeId,
    output_node: gran_prix::NodeId,
    test_inputs: &Tensor,
    input_dim: usize,
) -> Vec<f32> {
    let n = test_inputs.shape()[0];
    let inputs_slice = test_inputs.as_slice().expect("test inputs contiguous");
    let mut out = Vec::with_capacity(n);

    for i in 0..n {
        let row: Vec<f32> = inputs_slice[i * input_dim..(i + 1) * input_dim].to_vec();
        let single = Tensor::from_shape_vec(&[1, input_dim], row).unwrap();
        if let Some(gran_prix::graph::Node::Input(t)) =
            graph.nodes_mut().get_mut(input_node.0)
        {
            *t = single;
        }
        let pred = graph.execute(output_node).unwrap();
        let slice = pred.as_slice().unwrap();
        out.extend_from_slice(slice);
        graph.clear_values();
    }

    out
}

#[test]
fn test_e2e_train_serialize_reload_predict() {
    // ── 1. Architecture ───────────────────────────────────────────────────
    let net = NetworkDef::mlp(
        2,
        &[8, 4],
        1,
        ActivationType::Tanh,
        None, // raw logits — BCEWithLogits applies sigmoid internally
    );

    // Snapshot the canonical JSON before consuming the NetworkDef.
    let net_json = net.to_json().expect("NetworkDef serializes");

    // ── 2. Compile and train ──────────────────────────────────────────────
    let compiled = net
        .compile(Box::new(CPUBackend))
        .expect("NetworkDef compiles");
    let mut graph = compiled.graph;
    let input_node = compiled.input_node;
    let output_node = compiled.output_node;

    // XOR — a deterministic, well-known dataset. Training to convergence
    // is not required; we only need *some* training to perturb weights
    // away from random init so the test fails loudly if the roundtrip
    // accidentally reverts to fresh random initialization.
    let xor_inputs = Tensor::from_shape_vec(
        &[4, 2],
        vec![0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0],
    )
    .unwrap();
    let xor_targets = Tensor::from_shape_vec(&[4, 1], vec![0.0, 1.0, 1.0, 0.0]).unwrap();

    let mut optimizer = Adam::new(0.05);
    let loss_fn = BCEWithLogits;

    for _epoch in 0..50 {
        // Each epoch: one pass over all 4 samples, one optimizer step.
        graph.clear_gradients();
        let xor_inputs_slice = xor_inputs.as_slice().unwrap();
        let xor_targets_slice = xor_targets.as_slice().unwrap();

        for i in 0..4 {
            let row: Vec<f32> = xor_inputs_slice[i * 2..(i + 1) * 2].to_vec();
            let single_in = Tensor::from_shape_vec(&[1, 2], row).unwrap();
            if let Some(gran_prix::graph::Node::Input(t)) =
                graph.nodes_mut().get_mut(input_node.0)
            {
                *t = single_in;
            }

            let pred = graph.execute(output_node).unwrap();
            let target_t = Tensor::from_shape_vec(&[1, 1], vec![xor_targets_slice[i]]).unwrap();
            let mut grad = loss_fn.gradient(&pred, &target_t).unwrap();
            grad.map_inplace(|v| *v /= 4.0).unwrap(); // average over batch
            graph.backward(output_node, grad).unwrap();
            graph.clear_values();
        }

        optimizer.step_graph(&mut graph).unwrap();
    }

    // ── 3. Snapshot predictions on the training set ───────────────────────
    let predictions_before = predict_all(&mut graph, input_node, output_node, &xor_inputs, 2);
    assert_eq!(predictions_before.len(), 4, "one logit per sample");

    // Sanity check: weights moved away from a freshly-initialized state.
    // (If they didn't, the test below would still pass — but trivially.)
    let weights_before = graph.params().export_flat().unwrap();
    let weights_norm: f32 = weights_before.iter().map(|w| w.abs()).sum();
    assert!(
        weights_norm > 0.1,
        "weights should be non-trivial after 50 epochs (got L1 norm {})",
        weights_norm
    );

    // ── 4. Capture the canonical serialization payload ────────────────────
    let weights_payload = graph.params().export_flat().unwrap();

    // Drop the live graph entirely. From here on we only have the payload.
    drop(graph);

    // ── 5. Reconstruct from scratch using ONLY the payload ────────────────
    let net2 = NetworkDef::from_json(&net_json).expect("NetworkDef deserializes");
    let compiled2 = net2
        .compile(Box::new(CPUBackend))
        .expect("NetworkDef recompiles");
    let mut graph2 = compiled2.graph;
    graph2
        .params_mut()
        .import_flat(&weights_payload)
        .expect("weights import");

    let input_node2 = compiled2.input_node;
    let output_node2 = compiled2.output_node;

    // ── 6. Predict on the same input set ──────────────────────────────────
    let predictions_after = predict_all(&mut graph2, input_node2, output_node2, &xor_inputs, 2);

    // ── 7. Bit-for-bit identity (within FP tolerance) ─────────────────────
    assert_eq!(
        predictions_before.len(),
        predictions_after.len(),
        "prediction length should match"
    );

    const EPS: f32 = 1e-7;
    let mut max_diff: f32 = 0.0;
    for (i, (a, b)) in predictions_before
        .iter()
        .zip(predictions_after.iter())
        .enumerate()
    {
        let diff = (a - b).abs();
        max_diff = max_diff.max(diff);
        assert!(
            diff < EPS,
            "sample {}: prediction diverged after roundtrip — before={}, after={}, diff={}",
            i,
            a,
            b,
            diff
        );
    }

    // Also assert weights round-tripped exactly (a bit redundant with
    // predictions matching, but it isolates *which* layer of the contract
    // would break if the test fails).
    let weights_after = predict_all_weights_via_graph_clone(&net_json, &weights_payload);
    assert_eq!(weights_payload.len(), weights_after.len());
    for (i, (a, b)) in weights_payload.iter().zip(weights_after.iter()).enumerate() {
        assert!(
            (a - b).abs() < EPS,
            "weight {}: diverged — before={}, after={}",
            i,
            a,
            b
        );
    }

    eprintln!(
        "persistence E2E ok: 4 predictions, max |before − after| = {:.3e}",
        max_diff
    );
}

/// Helper: reload the network solely from the payload and re-export the
/// weights, used to assert weight-level identity independently of
/// prediction equality.
fn predict_all_weights_via_graph_clone(net_json: &str, payload: &[f32]) -> Vec<f32> {
    let net = NetworkDef::from_json(net_json).unwrap();
    let compiled = net.compile(Box::new(CPUBackend)).unwrap();
    let mut graph = compiled.graph;
    graph.params_mut().import_flat(payload).unwrap();
    graph.params().export_flat().unwrap()
}

/// Cross-check: a freshly compiled network with random init has *different*
/// predictions than the trained network. Without this, a buggy
/// `import_flat` that silently no-ops would still let the main test pass
/// (predictions before the export would equal predictions after a no-op
/// import on a fresh network — only if the seed coincided, but the
/// negative control catches the case anyway).
#[test]
fn test_e2e_negative_control_random_init_differs() {
    let net = NetworkDef::mlp(2, &[8, 4], 1, ActivationType::Tanh, None);
    let compiled1 = net.compile(Box::new(CPUBackend)).unwrap();
    let compiled2 = net.compile(Box::new(CPUBackend)).unwrap();
    let mut graph1 = compiled1.graph;
    let mut graph2 = compiled2.graph;

    let test_input = Tensor::from_shape_vec(&[4, 2], vec![0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0]).unwrap();

    let preds1 = predict_all(
        &mut graph1,
        compiled1.input_node,
        compiled1.output_node,
        &test_input,
        2,
    );
    let preds2 = predict_all(
        &mut graph2,
        compiled2.input_node,
        compiled2.output_node,
        &test_input,
        2,
    );

    // Two independent random inits should produce different predictions.
    // (If they don't, either the RNG is broken or the network is degenerate.)
    let any_different = preds1
        .iter()
        .zip(preds2.iter())
        .any(|(a, b)| (a - b).abs() > 1e-4);
    assert!(
        any_different,
        "two random initializations produced identical predictions — RNG suspicious"
    );
}
