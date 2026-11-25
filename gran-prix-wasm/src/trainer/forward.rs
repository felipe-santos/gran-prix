//! Shared inference primitives of the [`Trainer`](super::Trainer): one
//! batched forward pass and the output head (sigmoid / row-softmax).

use super::{js_err, LossKind};
use gran_prix::graph::Graph;
use gran_prix::{NodeId, Tensor};
use wasm_bindgen::prelude::*;

/// Runs a single batched forward pass on `graph` and returns the
/// raw logit values from the output node as a flat `Vec<f32>`.
///
/// This is the shared core of `predict_batch` and `predict_probs_batch`.
/// Centralizing the snapshot/restore lets both methods present the
/// same externally-observable contract: at exit, the input node holds
/// **exactly** the tensor it held at entry — same shape, same values.
/// Restoration runs on both the success and the error path; an error
/// during `execute` does not leave the graph's input in a half-modified
/// state.
pub(super) fn batched_forward_logits(
    graph: &mut Graph,
    input_node: usize,
    output_node: NodeId,
    input_dim: usize,
    batch_size: usize,
    inputs: Vec<f32>,
) -> Result<Vec<f32>, JsValue> {
    // Snapshot the original input tensor so we can restore it
    // bit-for-bit at exit. Tiny clone — the input is `[1, input_dim]`
    // for a fresh `Trainer`, and even after `train_batch`'s copy-in
    // it's bounded by a single sample.
    let original_input = match graph.nodes().get(input_node) {
        Some(gran_prix::graph::Node::Input(t)) => t.clone(),
        _ => return Err(JsValue::from_str("batched forward: input node not Input")),
    };

    // Widen the input node for the batched forward.
    let batch_tensor =
        Tensor::from_shape_vec(&[batch_size, input_dim], inputs).map_err(js_err)?;
    if let Some(gran_prix::graph::Node::Input(t)) = graph.nodes_mut().get_mut(input_node) {
        *t = batch_tensor;
    }
    graph.clear_values();

    let exec_result = graph.execute(output_node);

    // Restore — runs on success and error paths.
    if let Some(gran_prix::graph::Node::Input(t)) = graph.nodes_mut().get_mut(input_node) {
        *t = original_input;
    }
    graph.clear_values();

    let result = exec_result.map_err(js_err)?;
    let logits = result.as_slice().map_err(js_err)?.to_vec();
    Ok(logits)
}

/// Applies the output activation that corresponds to a [`LossKind`].
/// Splits the flat logit buffer into rows of length `output_dim` and
/// applies sigmoid (binary) or numerically-stable softmax (multi-class).
pub(super) fn apply_output_activation(logits: &[f32], output_dim: usize, kind: LossKind) -> Vec<f32> {
    let mut out = Vec::with_capacity(logits.len());
    match kind {
        LossKind::BinaryCrossEntropy => {
            // Each output is independently sigmoid-mapped; multi-output
            // here means independent binary heads, which we don't
            // currently use but the code is unambiguous.
            for &l in logits {
                out.push(1.0 / (1.0 + (-l).exp()));
            }
        }
        LossKind::CategoricalCrossEntropy => {
            // Row-wise softmax with `max - x` trick for numerical
            // stability. Same algorithm as
            // `CrossEntropyWithLogits::gradient` in the core crate.
            let rows = logits.len() / output_dim;
            for r in 0..rows {
                let start = r * output_dim;
                let row = &logits[start..start + output_dim];
                let max_val = row.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
                let exp_row: Vec<f32> = row.iter().map(|&v| (v - max_val).exp()).collect();
                let sum: f32 = exp_row.iter().sum::<f32>().max(1e-10);
                for e in exp_row {
                    out.push(e / sum);
                }
            }
        }
    }
    out
}
