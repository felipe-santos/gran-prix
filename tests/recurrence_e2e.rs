//! Behavioral tests that pin the recurrence contract through the
//! `NetworkDef::compile` + `CompiledNetwork::update_states` path.
//!
//! Before the temporal-state plumbing fix in `CompiledNetwork::update_states`,
//! recurrence didn't actually work via this path: layer `forward()`
//! is called once at compile time, which captures the previous-state
//! tensor as an `Input` node with the initial (zero) value; subsequent
//! `execute()` calls re-run the same fixed graph and never see any
//! updated state. The fix tracks `prev_state_input_id` on each
//! recurrent layer and, in `update_states`, writes the new hidden
//! state back into that input node *and* invalidates the engine's
//! value cache.
//!
//! The tests below produce two consecutive forwards with the *same*
//! input. With the fix, the second forward must see a non-zero
//! previous hidden state and therefore produce a different output
//! than the first. That difference is the proof that recurrence works.
//! Without the fix, both forwards produce identical outputs (the bug).

use gran_prix::backend::cpu::CPUBackend;
use gran_prix::network_def::{LayerDef, NetworkDef};
use gran_prix::Tensor;

/// Loads a single `[1, input_dim]` row into the network's input node
/// and returns the network's output as a `Vec<f32>`. Centralizes the
/// "match on `Node::Input` and overwrite the tensor" pattern so each
/// test reads cleanly.
fn forward_once(
    compiled: &mut gran_prix::network_def::CompiledNetwork,
    row: &[f32],
    input_dim: usize,
) -> Vec<f32> {
    let single = Tensor::from_shape_vec(&[1, input_dim], row.to_vec()).unwrap();
    if let Some(gran_prix::graph::Node::Input(t)) =
        compiled.graph.nodes_mut().get_mut(compiled.input_node.0)
    {
        *t = single;
    }
    let out = compiled
        .graph
        .execute(compiled.output_node)
        .expect("forward succeeds");
    out.as_slice().expect("contiguous output").to_vec()
}

/// Same input twice through an RNN: first forward sees zero previous
/// state, second forward sees the hidden state produced by the first.
/// With the plumbing fix the two outputs must differ.
#[test]
fn rnn_recurrence_changes_output_across_consecutive_forwards() {
    let net = NetworkDef::new(2, vec![
        LayerDef::Rnn { input_size: 2, hidden_size: 4 },
    ]);
    let mut compiled = net.compile(Box::new(CPUBackend)).unwrap();

    // Non-zero input — a `[0, 0]` row would zero out both linear
    // projections and obscure any recurrence-driven difference.
    let row = [0.7, -0.4];

    let out1 = forward_once(&mut compiled, &row, 2);
    compiled.update_states(); // propagates h_t into the h_prev input
    let out2 = forward_once(&mut compiled, &row, 2);

    assert_eq!(out1.len(), out2.len(), "shape consistency");
    assert_eq!(out1.len(), 4, "RNN output is the hidden vector");
    // The two outputs must differ in at least one element. Use a
    // generous threshold (1e-5) to discount FP noise but still catch
    // the bug, which would produce element-wise identity.
    let any_different = out1.iter().zip(out2.iter()).any(|(a, b)| (a - b).abs() > 1e-5);
    assert!(
        any_different,
        "RNN output identical across consecutive forwards — recurrence is broken.\n\
         out1={out1:?}\nout2={out2:?}"
    );
}

/// Same idea for GRU. GRU has more parameters (3 gates × 2 projections),
/// so the recurrence-driven difference is typically larger than RNN's
/// — but we still use the same loose 1e-5 element-wise threshold.
#[test]
fn gru_recurrence_changes_output_across_consecutive_forwards() {
    let net = NetworkDef::new(2, vec![
        LayerDef::Gru { input_size: 2, hidden_size: 4 },
    ]);
    let mut compiled = net.compile(Box::new(CPUBackend)).unwrap();

    let row = [0.7, -0.4];
    let out1 = forward_once(&mut compiled, &row, 2);
    compiled.update_states();
    let out2 = forward_once(&mut compiled, &row, 2);

    assert_eq!(out1.len(), out2.len());
    assert_eq!(out1.len(), 4);
    let any_different = out1.iter().zip(out2.iter()).any(|(a, b)| (a - b).abs() > 1e-5);
    assert!(
        any_different,
        "GRU output identical across consecutive forwards — recurrence is broken.\n\
         out1={out1:?}\nout2={out2:?}"
    );
}

/// `reset_states` clears the layer's `hidden_state` field. After a
/// reset the *next* forward should behave as if it were the first
/// — the network has no episodic memory.
///
/// This test runs:
///   - forward A
///   - update_states (hidden state now non-zero)
///   - forward B (uses non-zero state, output differs from A)
///   - reset_states
///   - forward C (should behave like the first forward again, output ≈ A)
///
/// "≈ A" is bit-identical because the layer's `hidden_state` is None
/// after reset, which is exactly what the layer started with.
#[test]
fn reset_states_returns_rnn_to_zero_initial_state() {
    let net = NetworkDef::new(2, vec![
        LayerDef::Rnn { input_size: 2, hidden_size: 4 },
    ]);
    let mut compiled = net.compile(Box::new(CPUBackend)).unwrap();

    let row = [0.7, -0.4];
    let out_a = forward_once(&mut compiled, &row, 2);
    compiled.update_states();
    let out_b = forward_once(&mut compiled, &row, 2);
    assert_ne!(out_a, out_b, "sanity: B must differ from A after update_states");

    compiled.reset_states();

    // After reset, the layer's hidden_state is None, but the
    // previous-state input node in the graph still holds the value
    // we wrote during update_states. We have to clear it explicitly
    // — see the doc-comment on `reset_states`. Without this, the
    // next forward sees the lingering h_t from before the reset.
    if let Some(prev_id) = compiled.stateful_layers.first().unwrap().prev_state_input() {
        if let Some(gran_prix::graph::Node::Input(t)) =
            compiled.graph.nodes_mut().get_mut(prev_id.0)
        {
            *t = Tensor::new_zeros(t.shape());
        }
    }
    compiled.graph.clear_values();

    let out_c = forward_once(&mut compiled, &row, 2);
    assert_eq!(out_a, out_c, "after reset + zeroed input, output matches initial forward");
}

/// Multi-step recurrence: feed three different inputs in sequence.
/// Each output is a function of all preceding inputs (through the
/// chain of hidden states). Re-feeding the same sequence after a
/// reset should reproduce the same outputs bit-for-bit.
#[test]
fn rnn_recurrence_is_deterministic_and_replayable() {
    let net = NetworkDef::new(2, vec![
        LayerDef::Rnn { input_size: 2, hidden_size: 4 },
    ]);
    let mut compiled = net.compile(Box::new(CPUBackend)).unwrap();

    let seq = [[0.5, -0.2], [0.1, 0.8], [-0.3, 0.4]];

    let run = |compiled: &mut gran_prix::network_def::CompiledNetwork| -> Vec<Vec<f32>> {
        let mut outs = Vec::with_capacity(seq.len());
        for row in seq.iter() {
            outs.push(forward_once(compiled, row, 2));
            compiled.update_states();
        }
        outs
    };

    let outs1 = run(&mut compiled);

    // Reset cleanly: clear hidden_state and zero the prev_state input.
    compiled.reset_states();
    if let Some(prev_id) = compiled.stateful_layers.first().unwrap().prev_state_input() {
        if let Some(gran_prix::graph::Node::Input(t)) =
            compiled.graph.nodes_mut().get_mut(prev_id.0)
        {
            *t = Tensor::new_zeros(t.shape());
        }
    }
    compiled.graph.clear_values();

    let outs2 = run(&mut compiled);

    assert_eq!(outs1, outs2, "sequence replay must be deterministic");
    assert_eq!(outs1.len(), 3);
    // Sanity: the three outputs in a sequence must not all be equal —
    // otherwise the recurrence is having no effect.
    assert_ne!(outs1[0], outs1[1]);
    assert_ne!(outs1[1], outs1[2]);
}
