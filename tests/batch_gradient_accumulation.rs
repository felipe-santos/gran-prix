//! Regression test for the per-node gradient leak between `backward` calls.
//!
//! Before the fix, `ExecutionEngine::backward` kept the gradients of
//! intermediate (and input) nodes alive after the call, so the next `backward`
//! in the same batch added its own gradient on top of the stale one and the
//! parameter gradients of sample N were contaminated by samples 1..N-1.
//!
//! Contract pinned here: after `clear_gradients()` once, running
//! forward+backward for each sample accumulates in the `ParamStore` exactly
//! the sum of the per-sample parameter gradients.

use gran_prix::backend::cpu::CPUBackend;
use gran_prix::graph::{Graph, Node};
use gran_prix::layers::ActivationType;
use gran_prix::network_def::{LayerDef, NetworkDef};
use gran_prix::{NodeId, Tensor};

const TOL: f32 = 1e-6;

/// 2 -> 4 -> tanh -> 4 -> 1 (logit output), plus its input/output node ids.
fn build() -> (Graph, usize, NodeId) {
    let net = NetworkDef::new(
        2,
        vec![
            LayerDef::Linear { in_features: 2, out_features: 4 },
            LayerDef::Activation { function: ActivationType::Tanh },
            LayerDef::Linear { in_features: 4, out_features: 1 },
        ],
    );
    let compiled = net.compile(Box::new(CPUBackend)).unwrap();
    (compiled.graph, compiled.input_node.0, compiled.output_node)
}

/// Forward + backward for one sample. The upstream gradient depends on the
/// output, so it differs per sample and per call (like a real loss gradient).
fn forward_backward(graph: &mut Graph, input_node: usize, out: NodeId, x: [f32; 2], y: f32) {
    if let Some(Node::Input(t)) = graph.nodes_mut().get_mut(input_node) {
        *t = Tensor::from_shape_vec(&[1, 2], x.to_vec()).unwrap();
    }
    let result = graph.execute(out).unwrap();
    let logit = result.as_slice().unwrap()[0];
    let grad = Tensor::from_shape_vec(&[1, 1], vec![logit - y]).unwrap();
    graph.backward(out, grad).unwrap();
}

/// Flat copy of every parameter gradient currently in the `ParamStore`.
fn param_grads(graph: &Graph) -> Vec<f32> {
    let mut flat = Vec::new();
    for (id, _) in graph.params().iter() {
        let g = graph.params().gradient(id).expect("parameter has no gradient");
        flat.extend_from_slice(g.as_slice().unwrap());
    }
    flat
}

const SAMPLES: [([f32; 2], f32); 3] = [
    ([0.9, -0.4], 1.0),
    ([-0.3, 0.7], 0.0),
    ([0.5, 0.5], 1.0),
];

#[test]
fn batch_param_gradients_equal_sum_of_per_sample_gradients() {
    let (mut graph, input_node, out) = build();

    // (a) One sample at a time, clearing before each, and sum by hand.
    let mut expected: Vec<f32> = Vec::new();
    for (x, y) in SAMPLES {
        graph.clear_gradients();
        forward_backward(&mut graph, input_node, out, x, y);
        let g = param_grads(&graph);
        if expected.is_empty() {
            expected = g;
        } else {
            for (e, v) in expected.iter_mut().zip(g) {
                *e += v;
            }
        }
    }
    assert!(
        expected.iter().any(|v| v.abs() > 1e-3),
        "test is vacuous: gradients are all ~0"
    );

    // (b) Clear once, then forward+backward per sample (the Trainer loop).
    graph.clear_gradients();
    for (x, y) in SAMPLES {
        forward_backward(&mut graph, input_node, out, x, y);
    }
    let batched = param_grads(&graph);

    assert_eq!(batched.len(), expected.len());
    for (i, (b, e)) in batched.iter().zip(&expected).enumerate() {
        assert!(
            (b - e).abs() <= TOL,
            "param grad [{i}]: batched {b} != sum of per-sample {e}"
        );
    }
}

#[test]
fn node_gradients_are_per_call_not_accumulated() {
    let (mut graph, input_node, out) = build();

    // The input node's gradient is a pure node gradient (never forwarded to the
    // ParamStore), so it exposes the leak directly: after N identical calls it
    // must equal the single-call value, not N times it.
    let (x, y) = SAMPLES[0];
    graph.clear_gradients();
    forward_backward(&mut graph, input_node, out, x, y);
    let first = graph
        .get_gradient(NodeId(input_node))
        .expect("input gradient missing")
        .as_slice()
        .unwrap()
        .to_vec();
    assert!(first.iter().any(|v| v.abs() > 1e-3), "vacuous input gradient");

    for _ in 0..2 {
        forward_backward(&mut graph, input_node, out, x, y);
    }
    let last = graph
        .get_gradient(NodeId(input_node))
        .expect("input gradient missing")
        .as_slice()
        .unwrap()
        .to_vec();
    for (i, (a, b)) in first.iter().zip(&last).enumerate() {
        assert!((a - b).abs() <= TOL, "input grad [{i}] leaked: {a} vs {b}");
    }
}
