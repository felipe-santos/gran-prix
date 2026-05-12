//! Round-trip tests for the `(NetworkDef JSON, flat weights)` serialization
//! pair across the layer types this repo supports.
//!
//! # Determinism assumption
//!
//! Forward passes are asserted bit-identical via `assert_eq!` on `Vec<f32>`.
//! This requires that the forward pass be a deterministic function of
//! (architecture, weights, inputs) — same operation order, no parallel
//! reduction with non-associative FP. The current CPU backend satisfies
//! this. Adding a parallel matmul or non-deterministic kernel would
//! break these tests *correctly* — the failure would mean the serialization
//! pair no longer captures the full state needed for reproducible
//! inference, and the test should be loosened or the determinism
//! contract documented and enforced elsewhere.
//!
//! The repo can serialize `Graph` directly via `serde` for Rust-native paths,
//! but `Graph` skips its `engine` field (`#[serde(skip)]`) and there is no
//! existing test that proves a *trained* `Graph` re-instantiates with the
//! same forward behavior. This test pins down a different, simpler
//! contract that downstream consumers can rely on:
//!
//!     export = (NetworkDef::to_json, ParamStore::export_flat)
//!     import = NetworkDef::from_json + compile + ParamStore::import_flat
//!
//! The contract uses only primitives that already have unit tests
//! (`network_def::tests::test_json_roundtrip`,
//! `params::tests::test_export_import_flat`). This test composes them and
//! asserts that the composition preserves forward behavior.
//!
//! Deliberate choices:
//!  - **No training.** Training would also exercise Adam, BCEWithLogits,
//!    and gradient propagation — failures there would mask serialization
//!    bugs. Random initialization is sufficient to detect any drift in
//!    the round-trip.
//!  - **Bit-identical assertion** (`f32` equality, no tolerance). The
//!    inputs, weights, and architecture are all identical after the
//!    round-trip, so the forward pass must produce *exactly* the same
//!    bits. Any tolerance would hide a bug.

use gran_prix::backend::cpu::CPUBackend;
use gran_prix::network_def::{ActivationType, LayerDef, NetworkDef};
use gran_prix::Tensor;

/// Forwards `inputs[i, :]` through the graph one row at a time and
/// returns the concatenated outputs. We rewrite the input node's tensor
/// in place rather than reshaping the graph, matching how the WASM
/// `Trainer` runs single-sample inference in production.
fn forward_each(
    graph: &mut gran_prix::graph::Graph,
    input_node: gran_prix::NodeId,
    output_node: gran_prix::NodeId,
    inputs: &Tensor,
    input_dim: usize,
) -> Vec<f32> {
    let n = inputs.shape()[0];
    let inputs_slice = inputs.as_slice().expect("inputs contiguous");
    let mut out = Vec::new();

    for i in 0..n {
        let row = inputs_slice[i * input_dim..(i + 1) * input_dim].to_vec();
        let single = Tensor::from_shape_vec(&[1, input_dim], row).unwrap();
        if let Some(gran_prix::graph::Node::Input(t)) =
            graph.nodes_mut().get_mut(input_node.0)
        {
            *t = single;
        }
        let pred = graph.execute(output_node).unwrap();
        out.extend_from_slice(pred.as_slice().unwrap());
        graph.clear_values();
    }

    out
}

/// Generic round-trip check: a `NetworkDef` is serialized to JSON, its
/// weights to a flat `Vec<f32>`. A fresh process reconstructs the trainer
/// from those two artifacts and must produce bit-identical predictions.
///
/// Inputs are the same fixed batch of 4 two-element vectors used across
/// the test cases below — the test isn't about the data itself but about
/// the round-trip preserving forward behavior.
fn assert_roundtrip_preserves_forward(net: NetworkDef, inputs: &Tensor, input_dim: usize) {
    let net_json = net.to_json().expect("NetworkDef serializes");
    let compiled = net
        .compile(Box::new(CPUBackend))
        .expect("NetworkDef compiles");
    let mut graph = compiled.graph;
    let weights = graph.params().export_flat().expect("weights export");

    let predictions_before = forward_each(
        &mut graph,
        compiled.input_node,
        compiled.output_node,
        inputs,
        input_dim,
    );
    drop(graph);

    let net2 = NetworkDef::from_json(&net_json).expect("NetworkDef deserializes");
    let compiled2 = net2
        .compile(Box::new(CPUBackend))
        .expect("NetworkDef recompiles");
    let mut graph2 = compiled2.graph;
    graph2
        .params_mut()
        .import_flat(&weights)
        .expect("weights import");

    let predictions_after = forward_each(
        &mut graph2,
        compiled2.input_node,
        compiled2.output_node,
        inputs,
        input_dim,
    );

    // Bit-identical: same architecture, same weights, same inputs,
    // deterministic forward → must produce the same f32 values.
    assert_eq!(predictions_before, predictions_after);
}

fn xor_inputs() -> Tensor {
    Tensor::from_shape_vec(
        &[4, 2],
        vec![0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0],
    )
    .unwrap()
}

#[test]
fn networkdef_json_plus_flat_weights_preserves_forward_mlp() {
    let net = NetworkDef::mlp(2, &[4], 1, ActivationType::Tanh, None);
    assert_roundtrip_preserves_forward(net, &xor_inputs(), 2);
}

/// BatchNorm carries trainable `gamma` and `beta` parameters but, by the
/// design comment in `src/layers/batchnorm.rs`, does NOT maintain running
/// statistics across batches — every forward computes fresh batch stats.
/// That makes BatchNorm round-trip-safe: nothing layer-internal needs to
/// be preserved beyond what `ParamStore` already serializes.
#[test]
fn networkdef_json_plus_flat_weights_preserves_forward_batchnorm() {
    let net = NetworkDef::new(2, vec![
        LayerDef::Linear { in_features: 2, out_features: 4 },
        LayerDef::BatchNorm { num_features: 4 },
        LayerDef::Activation { function: ActivationType::Tanh },
        LayerDef::Linear { in_features: 4, out_features: 1 },
    ]);
    assert_roundtrip_preserves_forward(net, &xor_inputs(), 2);
}

/// A GRU with a fresh hidden state (`hidden_state == None`) round-trips
/// safely because `compile()` creates a new `GRUCell` whose state is also
/// `None`. The complementary scenario — a GRU with non-None
/// `hidden_state` at save time — is documented as a known gap below.
#[test]
fn networkdef_json_plus_flat_weights_preserves_forward_gru_fresh_state() {
    let net = NetworkDef::new(2, vec![
        LayerDef::Gru { input_size: 2, hidden_size: 4 },
        LayerDef::Linear { in_features: 4, out_features: 1 },
    ]);
    assert_roundtrip_preserves_forward(net, &xor_inputs(), 2);
}

/// Same coverage for the simpler RNN cell — its `hidden_state` is also
/// `#[serde(skip)]`, so the same constraints apply.
#[test]
fn networkdef_json_plus_flat_weights_preserves_forward_rnn_fresh_state() {
    let net = NetworkDef::new(2, vec![
        LayerDef::Rnn { input_size: 2, hidden_size: 4 },
        LayerDef::Linear { in_features: 4, out_features: 1 },
    ]);
    assert_roundtrip_preserves_forward(net, &xor_inputs(), 2);
}

/// Dropout in eval mode is identity. The roundtrip must preserve that
/// — adding a Dropout layer to a network must not change forward
/// behavior across the (NetworkDef.json, flat weights) pair.
#[test]
fn networkdef_json_plus_flat_weights_preserves_forward_dropout() {
    let net = NetworkDef::new(2, vec![
        LayerDef::Linear { in_features: 2, out_features: 4 },
        LayerDef::Dropout { rate: 0.5 },
        LayerDef::Activation { function: ActivationType::Tanh },
        LayerDef::Linear { in_features: 4, out_features: 1 },
    ]);
    assert_roundtrip_preserves_forward(net, &xor_inputs(), 2);
}

/// Structural assertion that the `(NetworkDef.json, flat weights)`
/// contract carries no hidden-state information.
///
/// `NetworkDef` has no `hidden_state` field — only `input_dim` and an
/// ordered list of `LayerDef` variants whose payloads describe shape,
/// not state. The serialized JSON therefore cannot encode any value
/// that would seed a `GRUCell` or `RNNCell` mid-episode after a
/// round-trip via this contract. Consumers that need to resume mid-
/// episode must persist the hidden state out of band (a sibling file
/// or extra payload). Documented in `KNOWN-GAPS.md`.
///
/// A purely behavioral test of this gap would also have to depend on
/// the temporal-state plumbing in `CompiledNetwork::update_states` and
/// the layer's graph-recompilation semantics, which add noise unrelated
/// to the contract. The structural check below is the right granularity
/// for this gap: it pins the JSON shape directly.
#[test]
fn known_gap_contract_json_carries_no_hidden_state() {
    let net = NetworkDef::new(2, vec![
        LayerDef::Gru { input_size: 2, hidden_size: 4 },
        LayerDef::Linear { in_features: 4, out_features: 1 },
    ]);
    let json = net.to_json().expect("NetworkDef serializes");
    let lower = json.to_lowercase();

    // None of the recurrent state field names should appear in the
    // serialized contract. If they ever do, the contract has been
    // extended and KNOWN-GAPS.md needs revisiting.
    for forbidden in ["hidden_state", "hiddenstate", "state_node"] {
        assert!(
            !lower.contains(forbidden),
            "NetworkDef JSON unexpectedly contains '{forbidden}': {json}\n\
             If this is intentional, update KNOWN-GAPS.md and remove this test."
        );
    }
}

/// `serde_json::to_string(&Graph)` round-trips a *trained* MLP without
/// drift.
///
/// Background: `Graph` derives `Serialize`/`Deserialize` but its
/// `engine` field is `#[serde(skip)]` (`src/graph/mod.rs`); a deserialized
/// `Graph` requires `set_backend(...)` to rebuild the engine. This
/// path was previously **untested for trained models**: only topology
/// round-trip was covered (`tests/persistence_flow_tests.rs`).
///
/// This test fills that gap. We train an MLP on XOR for 30 epochs,
/// snapshot its predictions, serialize the entire `Graph` to JSON,
/// deserialize, attach a fresh backend, and assert the predictions
/// match bit-for-bit.
///
/// If this test ever fails, the right move is **not** to add a
/// tolerance — it's to find the field that didn't round-trip, fix
/// the serde annotation, and reinstate strict equality.
#[test]
fn serde_json_to_string_round_trips_a_trained_graph() {
    use gran_prix::graph::{Graph, dsl::GraphBuilder};
    use gran_prix::loss::{Loss, BCEWithLogits};
    use gran_prix::optim::{Adam, Optimizer};

    // Build a small MLP directly (so we exercise the full Graph serde
    // path, not just the NetworkDef/flat-weights contract that
    // `assert_roundtrip_preserves_forward` covers).
    let mut graph = Graph::new(Box::new(CPUBackend));
    let input_node = graph.input(Tensor::new_zeros(&[1, 2]));
    let mut gb = GraphBuilder::new(&mut graph);
    let w1 = gb.named_param(Tensor::new_random(&[2, 4]), "w1");
    let b1 = gb.named_param(Tensor::new_zeros(&[1, 4]), "b1");
    let l1 = gb.linear(input_node, w1, b1);
    let h = gb.tanh(l1);
    let w2 = gb.named_param(Tensor::new_random(&[4, 1]), "w2");
    let b2 = gb.named_param(Tensor::new_zeros(&[1, 1]), "b2");
    let l2 = gb.linear(h, w2, b2);
    let output_node = l2;

    // Train a few epochs to move weights away from random init.
    let inputs = xor_inputs();
    let targets =
        Tensor::from_shape_vec(&[4, 1], vec![0.0, 1.0, 1.0, 0.0]).unwrap();
    let mut optimizer = Adam::new(0.05);
    let loss_fn = BCEWithLogits;

    for _ in 0..30 {
        graph.clear_gradients();
        let in_slice = inputs.as_slice().unwrap();
        let tgt_slice = targets.as_slice().unwrap();
        for i in 0..4 {
            let row = in_slice[i * 2..(i + 1) * 2].to_vec();
            if let Some(gran_prix::graph::Node::Input(t)) =
                graph.nodes_mut().get_mut(input_node.0)
            {
                *t = Tensor::from_shape_vec(&[1, 2], row).unwrap();
            }
            let pred = graph.execute(output_node).unwrap();
            let target_t =
                Tensor::from_shape_vec(&[1, 1], vec![tgt_slice[i]]).unwrap();
            let mut grad = loss_fn.gradient(&pred, &target_t).unwrap();
            grad.map_inplace(|v| *v /= 4.0).unwrap();
            graph.backward(output_node, grad).unwrap();
            graph.clear_values();
        }
        optimizer.step_graph(&mut graph).unwrap();
    }

    // Snapshot trained predictions.
    let predictions_before: Vec<Vec<f32>> = (0..4)
        .map(|i| {
            let row = inputs.as_slice().unwrap()[i * 2..(i + 1) * 2].to_vec();
            if let Some(gran_prix::graph::Node::Input(t)) =
                graph.nodes_mut().get_mut(input_node.0)
            {
                *t = Tensor::from_shape_vec(&[1, 2], row).unwrap();
            }
            let p = graph.execute(output_node).unwrap();
            graph.clear_values();
            p.as_slice().unwrap().to_vec()
        })
        .collect();

    // ── Serialize the entire Graph ─────────────────────────────────────
    let json = serde_json::to_string(&graph).expect("Graph serializes");
    drop(graph);

    let mut graph2: Graph =
        serde_json::from_str(&json).expect("Graph deserializes");
    // Engine is `#[serde(skip)]`; reattach a fresh CPU backend before
    // any execute call.
    graph2.set_backend(Box::new(CPUBackend));

    // ── Predict on the same set with the deserialized graph ────────────
    let predictions_after: Vec<Vec<f32>> = (0..4)
        .map(|i| {
            let row = inputs.as_slice().unwrap()[i * 2..(i + 1) * 2].to_vec();
            if let Some(gran_prix::graph::Node::Input(t)) =
                graph2.nodes_mut().get_mut(input_node.0)
            {
                *t = Tensor::from_shape_vec(&[1, 2], row).unwrap();
            }
            let p = graph2.execute(output_node).unwrap();
            graph2.clear_values();
            p.as_slice().unwrap().to_vec()
        })
        .collect();

    assert_eq!(
        predictions_before, predictions_after,
        "trained Graph drifted across serde round-trip"
    );
}

// ── Graph serde round-trip across layer types ─────────────────────────────
//
// `serde_json_to_string_round_trips_a_trained_graph` (above) exercised
// the full `Graph` serde path for an MLP. The audit flagged that
// `BatchNorm`, `Dropout`, `RNN`, `GRU` weren't covered. The helper
// below gives each layer type the same coverage, going through
// `NetworkDef::compile` (the standard construction path) instead of
// raw DSL.

fn assert_graph_serde_preserves_forward(net: NetworkDef, inputs: &Tensor, input_dim: usize) {
    use gran_prix::graph::Graph;

    let compiled = net
        .compile(Box::new(CPUBackend))
        .expect("NetworkDef compiles");
    let mut graph = compiled.graph;
    let input_node = compiled.input_node;
    let output_node = compiled.output_node;

    let predictions_before = forward_each(&mut graph, input_node, output_node, inputs, input_dim);

    // Round-trip via `serde_json::to_string(&Graph)` — the path that
    // skips `engine` and reattaches via `set_backend`.
    let json = serde_json::to_string(&graph).expect("Graph serializes");
    drop(graph);

    let mut graph2: Graph = serde_json::from_str(&json).expect("Graph deserializes");
    graph2.set_backend(Box::new(CPUBackend));

    let predictions_after = forward_each(&mut graph2, input_node, output_node, inputs, input_dim);

    assert_eq!(
        predictions_before, predictions_after,
        "Graph serde drifted across round-trip"
    );
}

#[test]
fn graph_serde_preserves_forward_mlp_via_compile() {
    let net = NetworkDef::mlp(2, &[8, 4], 1, ActivationType::ReLU, None);
    assert_graph_serde_preserves_forward(net, &xor_inputs(), 2);
}

#[test]
fn graph_serde_preserves_forward_batchnorm() {
    let net = NetworkDef::new(2, vec![
        LayerDef::Linear { in_features: 2, out_features: 4 },
        LayerDef::BatchNorm { num_features: 4 },
        LayerDef::Activation { function: ActivationType::Tanh },
        LayerDef::Linear { in_features: 4, out_features: 1 },
    ]);
    assert_graph_serde_preserves_forward(net, &xor_inputs(), 2);
}

#[test]
fn graph_serde_preserves_forward_dropout() {
    // Dropout in eval mode (the default) is identity, so the Graph
    // serde path should preserve forward exactly.
    let net = NetworkDef::new(2, vec![
        LayerDef::Linear { in_features: 2, out_features: 4 },
        LayerDef::Dropout { rate: 0.5 },
        LayerDef::Linear { in_features: 4, out_features: 1 },
    ]);
    assert_graph_serde_preserves_forward(net, &xor_inputs(), 2);
}

#[test]
fn graph_serde_preserves_forward_rnn_fresh_state() {
    // The recurrent layers have `#[serde(skip)]` on `hidden_state` —
    // both before and after deserialize the field is `None`, so a
    // fresh-state network round-trips cleanly. The mid-episode
    // gap is already pinned by `known_gap_contract_json_carries_no_*`.
    let net = NetworkDef::new(2, vec![
        LayerDef::Rnn { input_size: 2, hidden_size: 4 },
        LayerDef::Linear { in_features: 4, out_features: 1 },
    ]);
    assert_graph_serde_preserves_forward(net, &xor_inputs(), 2);
}

#[test]
fn graph_serde_preserves_forward_gru_fresh_state() {
    let net = NetworkDef::new(2, vec![
        LayerDef::Gru { input_size: 2, hidden_size: 4 },
        LayerDef::Linear { in_features: 4, out_features: 1 },
    ]);
    assert_graph_serde_preserves_forward(net, &xor_inputs(), 2);
}

// ── BatchNorm batched-vs-single regression ────────────────────────────────
//
// `BatchNorm` computes batch statistics from the input batch. The
// design comment in `src/layers/batchnorm.rs` notes this explicitly:
// running statistics are NOT maintained, so a single-sample forward
// (zero variance, falls back to ~affine via `eps`) produces a
// different output than a batched forward (real variance) for the
// same row.
//
// `predict_batch` and `predict_probs_batch` document this difference.
// This test pins the documented behavior so that any future change
// that adds running statistics has to update both the documentation
// and this test deliberately.
#[test]
fn batchnorm_output_differs_between_single_and_batched_forwards() {
    let net = NetworkDef::new(3, vec![
        LayerDef::Linear { in_features: 3, out_features: 4 },
        LayerDef::BatchNorm { num_features: 4 },
        LayerDef::Linear { in_features: 4, out_features: 1 },
    ]);
    let mut compiled = net.compile(Box::new(CPUBackend)).unwrap();

    // Single-sample forward of row 0.
    let row0 = vec![0.5_f32, -0.3, 0.1];
    let single_input = Tensor::from_shape_vec(&[1, 3], row0.clone()).unwrap();
    if let Some(gran_prix::graph::Node::Input(t)) =
        compiled.graph.nodes_mut().get_mut(compiled.input_node.0)
    {
        *t = single_input;
    }
    let single_out = compiled
        .graph
        .execute(compiled.output_node)
        .unwrap()
        .as_slice()
        .unwrap()
        .to_vec();
    compiled.graph.clear_values();

    // Batched forward over four DIFFERENT rows including row 0.
    // Different rows give non-zero variance, which triggers BN's
    // real branch rather than the eps-only fallback.
    let batched_data: Vec<f32> = vec![
        0.5, -0.3, 0.1,
        0.7, 0.2, -0.4,
        -0.1, 0.6, 0.3,
        0.9, -0.5, 0.0,
    ];
    let batched_input = Tensor::from_shape_vec(&[4, 3], batched_data).unwrap();
    if let Some(gran_prix::graph::Node::Input(t)) =
        compiled.graph.nodes_mut().get_mut(compiled.input_node.0)
    {
        *t = batched_input;
    }
    let batched_out = compiled
        .graph
        .execute(compiled.output_node)
        .unwrap()
        .as_slice()
        .unwrap()
        .to_vec();

    // Row 0's output in the batched run is the first scalar (output_dim=1).
    let batched_row0 = batched_out[0];
    let single_row0 = single_out[0];

    assert_ne!(
        single_row0, batched_row0,
        "BatchNorm should produce different outputs for the same row in single-sample \
         vs. multi-sample forward — single={}, batched_row0={}. If this test now passes, \
         BatchNorm has been changed to track running statistics across batches; update \
         `src/layers/batchnorm.rs` doc and the predict_batch/predict_probs_batch docs.",
        single_row0, batched_row0
    );
}

/// Same structural check for `RNNCell` — its `hidden_state` is also
/// `#[serde(skip)]`.
#[test]
fn known_gap_contract_json_carries_no_rnn_hidden_state() {
    let net = NetworkDef::new(2, vec![
        LayerDef::Rnn { input_size: 2, hidden_size: 4 },
        LayerDef::Linear { in_features: 4, out_features: 1 },
    ]);
    let json = net.to_json().expect("NetworkDef serializes");
    let lower = json.to_lowercase();
    for forbidden in ["hidden_state", "hiddenstate"] {
        assert!(
            !lower.contains(forbidden),
            "NetworkDef JSON unexpectedly contains '{forbidden}': {json}"
        );
    }
}
