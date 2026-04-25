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
use gran_prix::network_def::{ActivationType, NetworkDef};
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

#[test]
fn networkdef_json_plus_flat_weights_preserves_forward() {
    let net = NetworkDef::mlp(2, &[4], 1, ActivationType::Tanh, None);
    let net_json = net.to_json().expect("NetworkDef serializes");

    let compiled = net
        .compile(Box::new(CPUBackend))
        .expect("NetworkDef compiles");
    let mut graph = compiled.graph;

    // Random init of weights happens inside compile(). Snapshot them
    // along with the predictions they produce.
    let weights = graph.params().export_flat().expect("weights export");
    let inputs = Tensor::from_shape_vec(
        &[4, 2],
        vec![0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0],
    )
    .unwrap();
    let predictions_before = forward_each(
        &mut graph,
        compiled.input_node,
        compiled.output_node,
        &inputs,
        2,
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
        &inputs,
        2,
    );

    // After the round-trip the architecture is identical, the weights are
    // identical, and the inputs are identical. The forward pass is a
    // deterministic function of those — it must produce exactly the same
    // floats. No tolerance.
    assert_eq!(predictions_before, predictions_after);
}
