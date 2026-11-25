//! Per-split metrics at a threshold (used by `train` for the validation headline and by `eval`).

use crate::loss::{sigmoid_f32, WeightedBce};
use crate::threshold::{average_precision, Confusion};
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct Metrics {
    pub n: usize,
    pub n_pos: usize,
    pub threshold: f32,
    pub confusion: Confusion,
    pub precision: f64,
    pub recall: f64,
    pub f1: f64,
    pub accuracy: f64,
    /// Unweighted binary cross-entropy of the logits.
    pub bce: f64,
    pub average_precision: Option<f64>,
}

impl Metrics {
    /// `logits` are the network outputs; scores are their sigmoid (calibration `none`).
    pub fn compute(logits: &[f32], ys: &[u8], threshold: f32) -> Metrics {
        let scores: Vec<f32> = logits.iter().map(|z| sigmoid_f32(*z)).collect();
        let confusion = Confusion::at(&scores, ys, threshold);
        Metrics {
            n: ys.len(),
            n_pos: ys.iter().filter(|y| **y == 1).count(),
            threshold,
            precision: confusion.precision(),
            recall: confusion.recall(),
            f1: confusion.f1(),
            accuracy: confusion.accuracy(),
            confusion,
            bce: f64::from(WeightedBce::plain().mean_loss(logits, ys)),
            average_precision: average_precision(&scores, ys),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "n": self.n,
            "n_pos": self.n_pos,
            "threshold": f64::from(self.threshold),
            "tp": self.confusion.tp,
            "fp": self.confusion.fp,
            "tn": self.confusion.tn,
            "fn": self.confusion.fn_,
            "precision": self.precision,
            "recall": self.recall,
            "f1": self.f1,
            "accuracy": self.accuracy,
            "bce": self.bce,
            "average_precision": self.average_precision,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metrics_follow_the_confusion_matrix() {
        // logits -> scores 0.88, 0.62, 0.38, 0.12
        let logits = [2.0f32, 0.5, -0.5, -2.0];
        let ys = [1u8, 0, 1, 0];
        let m = Metrics::compute(&logits, &ys, 0.5);
        assert_eq!(m.confusion, Confusion { tp: 1, fp: 1, tn: 1, fn_: 1 });
        assert_eq!((m.n, m.n_pos), (4, 2));
        assert!((m.f1 - 0.5).abs() < 1e-12);
        assert!(m.bce > 0.0 && m.average_precision.is_some());
        assert_eq!(m.to_json()["fn"], 1);
    }
}
