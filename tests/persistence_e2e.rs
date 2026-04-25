//! Round-trip test for the `(NetworkDef JSON, flat weights)` serialization
//! pair.
//!
//! The repo serializes `Graph` directly via `serde` for some legacy paths,
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
/// `None`. This pins down the contract that *fresh-state* GRUs serialize
/// correctly. The complementary scenario — a GRU with non-None
/// `hidden_state` at save time — is documented as a known gap below.
#[test]
fn networkdef_json_plus_flat_weights_preserves_forward_gru_fresh_state() {
    let net = NetworkDef::new(2, vec![
        LayerDef::Gru { input_size: 2, hidden_size: 4 },
        LayerDef::Linear { in_features: 4, out_features: 1 },
    ]);
    assert_roundtrip_preserves_forward(net, &xor_inputs(), 2);
}

/// Documents a known gap: `RNNCell::hidden_state` and
/// `GRUCell::hidden_state` are `#[serde(skip)]` in `src/layers/rnn.rs`
/// and `src/layers/gru.rs`. They are *not* part of the
/// `(NetworkDef.json, flat weights)` contract. The contract only
/// preserves *fresh-state* recurrent layers; consumers that need to
/// resume mid-episode must persist the hidden state themselves out of
/// band.
///
/// This test asserts the gap exists rather than pretending it's solved —
/// `NetworkDef` does not even carry layer-internal state, so the
/// round-trip path through `(NetworkDef.json, flat weights)` cannot
/// preserve hidden state by construction. The intent here is purely
/// documentary: any future change that pretends to round-trip hidden
/// state must update this test (and the contract).
#[test]
fn known_gap_recurrent_hidden_state_is_not_part_of_contract() {
    // Construct a GRU and use its hidden_state mutator directly to
    // simulate a mid-episode save. After round-tripping just
    // `(NetworkDef.json, flat weights)`, the new GRU has no way to
    // recover that state.
    use gran_prix::layers::GRUCell;
    let mut gru = GRUCell::new(2, 4);
    gru.hidden_state = Some(Tensor::from_elem(&[1, 4], 0.7));
    assert!(gru.hidden_state.is_some());

    // What the contract *does* preserve (the trainable weights) and what
    // it *does not* (hidden_state) are clear by inspection of the
    // `#[serde(skip)]` annotations on the layer struct. We sanity-check
    // here that the field is in fact skipped from the layer's own
    // serialization round-trip.
    let json = serde_json::to_string(&gru).expect("GRUCell serializes");
    let restored: GRUCell = serde_json::from_str(&json).expect("GRUCell deserializes");
    assert!(
        restored.hidden_state.is_none(),
        "hidden_state survived the round-trip — the contract has changed and \
         this test (and the documentation in src/layers/gru.rs) needs an update"
    );
}
