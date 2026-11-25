//! Tests of `predictLogitsBatch` (raw logits), the batch input validation it
//! shares with the other batched predictors, and the unambiguous parameter
//! counts (`paramTensorCount` vs `weightCount`).
//!
//! Success paths only for the `Trainer` itself (`JsValue` cannot be built on
//! native targets); the validation helper returns a `String`, so its failure
//! paths are covered here too.

use super::inference::check_batch_inputs;
use super::{LossKind, Trainer};
use crate::network_info::summarize_network_def;
use gran_prix::layers::ActivationType;
use gran_prix::network_def::{LayerDef, NetworkDef};

fn json(input_dim: usize, hidden: usize, out: usize, extra: Option<LayerDef>) -> String {
    let mut layers = vec![
        LayerDef::Linear { in_features: input_dim, out_features: hidden },
        LayerDef::Activation { function: ActivationType::Tanh },
    ];
    layers.extend(extra);
    layers.push(LayerDef::Linear { in_features: hidden, out_features: out });
    NetworkDef::new(input_dim, layers).to_json().unwrap()
}

/// Deterministic, non-trivial batch (values spread over [-2, 2)).
fn batch(n: usize, dim: usize) -> Vec<f32> {
    (0..n * dim).map(|i| (((i * 37 + 11) % 97) as f32 / 97.0) * 4.0 - 2.0).collect()
}

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

#[test]
fn binary_logits_match_predict_batch_after_sigmoid() {
    let t = Trainer::from_network_def_seeded(&json(5, 7, 1, None), 42).unwrap();
    let x = batch(9, 5);
    let logits = t.predict_logits_batch(x.clone(), 9).unwrap();
    let probs = t.predict_batch(x, 9).unwrap();
    assert_eq!(logits.len(), 9);
    for (l, p) in logits.iter().zip(&probs) {
        assert!((sigmoid(*l) - p).abs() < 1e-6, "sigmoid({l}) = {} != {p}", sigmoid(*l));
    }
    // Raw means raw: the logits are not squashed into (0, 1).
    assert!(logits.iter().any(|l| !(0.0..=1.0).contains(l)), "logits look like probabilities");
}

#[test]
fn multiclass_logits_softmax_to_predict_probs_batch() {
    let t = Trainer::from_network_def_seeded(&json(4, 6, 3, None), 7).unwrap();
    assert_eq!(t.loss_kind(), LossKind::CategoricalCrossEntropy);
    let x = batch(6, 4);
    let logits = t.predict_logits_batch(x.clone(), 6).unwrap();
    let probs = t.predict_probs_batch(x, 6).unwrap();
    assert_eq!(logits.len(), 18);
    for r in 0..6 {
        let row = &logits[r * 3..r * 3 + 3];
        let max = row.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let e: Vec<f32> = row.iter().map(|v| (v - max).exp()).collect();
        let sum: f32 = e.iter().sum();
        for c in 0..3 {
            assert!((e[c] / sum - probs[r * 3 + c]).abs() < 1e-6, "row {r} class {c}");
        }
    }
}

#[test]
fn logits_of_a_row_do_not_depend_on_the_rest_of_the_batch() {
    let t = Trainer::from_network_def_seeded(&json(3, 5, 2, None), 1).unwrap();
    let x = batch(8, 3);
    let all = t.predict_logits_batch(x.clone(), 8).unwrap();
    for r in 0..8 {
        let one = t.predict_logits_batch(x[r * 3..r * 3 + 3].to_vec(), 1).unwrap();
        assert_eq!(&all[r * 2..r * 2 + 2], &one[..], "row {r}");
    }
}

#[test]
fn logits_are_deterministic_with_dropout_and_empty_batch_is_empty() {
    let def = json(3, 8, 1, Some(LayerDef::Dropout { rate: 0.5 }));
    let t = Trainer::from_network_def_seeded(&def, 3).unwrap();
    let x = batch(5, 3);
    let a = t.predict_logits_batch(x.clone(), 5).unwrap();
    let b = t.predict_logits_batch(x, 5).unwrap();
    assert_eq!(a, b, "eval-mode dropout must be the identity");
    assert!(t.predict_logits_batch(Vec::new(), 0).unwrap().is_empty());
}

#[test]
fn check_batch_inputs_reports_each_failure() {
    assert!(check_batch_inputs("f", &[0.0; 6], 3, 2).is_ok());
    let e = check_batch_inputs("f", &[0.0; 5], 3, 2).unwrap_err();
    assert_eq!(e, "f: inputs length 5 != batch_size 3 * input_dim 2");
    let e = check_batch_inputs("f", &[0.0, f32::NAN, 0.0, 0.0], 2, 2).unwrap_err();
    assert!(e.starts_with("f: input[1] is non-finite"), "{e}");
    let e = check_batch_inputs("f", &[f32::INFINITY], 1, 1).unwrap_err();
    assert!(e.contains("non-finite"), "{e}");
    let e = check_batch_inputs("f", &[], usize::MAX, 2).unwrap_err();
    assert_eq!(e, format!("f: batch_size={} * input_dim=2 overflows usize", usize::MAX));
}

#[test]
fn tensor_count_and_weight_count_are_distinct_and_consistent() {
    // 4 -> 3 -> 1: weights 4*3 + 3 + 3*1 + 1 = 19 floats in 4 tensors.
    let def = json(4, 3, 1, None);
    let t = Trainer::from_network_def(&def).unwrap();
    assert_eq!(t.param_tensor_count(), 4);
    assert_eq!(t.param_tensor_count(), t.param_names().len());
    assert_eq!(t.param_count(), t.param_tensor_count(), "deprecated alias keeps counting tensors");
    assert_eq!(t.weight_count(), 19);
    assert_eq!(t.weight_count(), t.get_weights().unwrap().len());
    let summary = summarize_network_def(&def);
    assert_eq!(summary.weight_count, Some(t.weight_count()), "validateNetworkDef agrees with the Trainer");
}
