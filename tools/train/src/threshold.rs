//! Metrics and threshold selection on the validation split.
//!
//! Decision rule everywhere: positive (`keep`) iff `score >= threshold` (the contract's
//! `score >= accept`). Scores are float32 probabilities.
//!
//! * `accept`: from the TrainConfig. `fixed` uses the value; `max_f1_on_val` sweeps every
//!   distinct validation score and takes the threshold of maximum F1 (ties: the highest
//!   threshold, i.e. the most precise). The candidate is the midpoint between the lowest
//!   accepted score and the highest rejected one, so tiny score differences between
//!   runtimes (~1e-7) cannot flip the boundary item.
//! * `escalate`: the contract has an escalate band `[escalate, accept)` for a stronger judge.
//!   gp-train v0 sets `escalate` to the highest threshold that keeps validation recall at
//!   least [`ESCALATE_RECALL`] (never above `accept`), so the band collects the positives
//!   the accept threshold would drop.
//! * `margin`: only meaningful for multi-class softmax outputs (top-1 / top-2 gap); 0 here.

use crate::config::ThresholdCfg;
use crate::error::Result;
use crate::invalid;
use serde::Serialize;

/// Validation recall that the escalate threshold must reach.
pub const ESCALATE_RECALL: f64 = 0.99;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct Confusion {
    pub tp: usize,
    pub fp: usize,
    pub tn: usize,
    pub fn_: usize,
}

impl Confusion {
    pub fn at(scores: &[f32], ys: &[u8], threshold: f32) -> Confusion {
        let mut c = Confusion::default();
        for (s, y) in scores.iter().zip(ys) {
            match (*s >= threshold, *y == 1) {
                (true, true) => c.tp += 1,
                (true, false) => c.fp += 1,
                (false, false) => c.tn += 1,
                (false, true) => c.fn_ += 1,
            }
        }
        c
    }

    pub fn n(&self) -> usize {
        self.tp + self.fp + self.tn + self.fn_
    }

    pub fn precision(&self) -> f64 {
        ratio(self.tp, self.tp + self.fp)
    }

    pub fn recall(&self) -> f64 {
        ratio(self.tp, self.tp + self.fn_)
    }

    pub fn f1(&self) -> f64 {
        ratio(2 * self.tp, 2 * self.tp + self.fp + self.fn_)
    }

    pub fn accuracy(&self) -> f64 {
        ratio(self.tp + self.tn, self.n())
    }
}

fn ratio(a: usize, b: usize) -> f64 {
    if b == 0 {
        0.0
    } else {
        a as f64 / b as f64
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Thresholds {
    pub accept: f32,
    pub escalate: f32,
    pub margin: f32,
}

/// Candidate thresholds in descending order: `(threshold, tp, fp)` of "score >= threshold".
fn sweep(scores: &[f32], ys: &[u8]) -> Vec<(f32, usize, usize)> {
    let mut order: Vec<usize> = (0..scores.len()).collect();
    order.sort_by(|a, b| scores[*b].total_cmp(&scores[*a]));
    let mut out = Vec::new();
    let (mut tp, mut fp) = (0usize, 0usize);
    let mut i = 0;
    while i < order.len() {
        let s = scores[order[i]];
        while i < order.len() && scores[order[i]] == s {
            if ys[order[i]] == 1 {
                tp += 1;
            } else {
                fp += 1;
            }
            i += 1;
        }
        // Midpoint towards the next (lower) distinct score, if it is representable strictly
        // between the two; otherwise the score itself.
        let t = match order.get(i) {
            Some(next) => {
                let lower = scores[*next];
                let mid = ((f64::from(s) + f64::from(lower)) / 2.0) as f32;
                if mid > lower && mid <= s {
                    mid
                } else {
                    s
                }
            }
            None => s,
        };
        out.push((t, tp, fp));
    }
    out
}

/// Threshold of maximum F1, or `None` when there are no positives.
pub fn best_f1_threshold(scores: &[f32], ys: &[u8]) -> Option<(f32, f64)> {
    let total_pos = ys.iter().filter(|y| **y == 1).count();
    if total_pos == 0 {
        return None;
    }
    let mut best: Option<(f32, f64)> = None;
    for (t, tp, fp) in sweep(scores, ys) {
        let fn_ = total_pos - tp;
        let f1 = ratio(2 * tp, 2 * tp + fp + fn_);
        if best.is_none_or(|(_, b)| f1 > b) {
            best = Some((t, f1));
        }
    }
    best
}

/// Highest threshold `<= accept` whose validation recall is at least `target`.
fn escalate_threshold(scores: &[f32], ys: &[u8], accept: f32, target: f64) -> f32 {
    let total_pos = ys.iter().filter(|y| **y == 1).count();
    if total_pos == 0 {
        return accept;
    }
    let mut lowest = accept;
    for (t, tp, _) in sweep(scores, ys) {
        if t > accept {
            continue;
        }
        lowest = t;
        if ratio(tp, total_pos) >= target {
            return t;
        }
    }
    lowest
}

/// Selects the thresholds of the model from validation scores.
///
/// `max_f1_on_val` needs a validation split with at least one positive; `fixed` works
/// without one (the escalate threshold then equals accept).
pub fn select(cfg: &ThresholdCfg, val_scores: &[f32], val_y: &[u8]) -> Result<Thresholds> {
    let accept = match cfg {
        ThresholdCfg::Fixed { value } => *value as f32,
        ThresholdCfg::MaxF1OnVal => match best_f1_threshold(val_scores, val_y) {
            Some((t, _)) => t,
            None => return Err(invalid!("threshold max_f1_on_val needs validation rows with at least one positive (got {} rows)", val_y.len())),
        },
    };
    let escalate = escalate_threshold(val_scores, val_y, accept, ESCALATE_RECALL).min(accept);
    Ok(Thresholds { accept, escalate, margin: 0.0 })
}

/// Average precision (area under the precision-recall step curve), `None` without positives.
pub fn average_precision(scores: &[f32], ys: &[u8]) -> Option<f64> {
    let total_pos = ys.iter().filter(|y| **y == 1).count();
    if total_pos == 0 {
        return None;
    }
    let (mut prev_recall, mut ap) = (0.0, 0.0);
    for (_, tp, fp) in sweep(scores, ys) {
        let recall = ratio(tp, total_pos);
        ap += (recall - prev_recall) * ratio(tp, tp + fp);
        prev_recall = recall;
    }
    Some(ap)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confusion_counts_and_derived_metrics() {
        let scores = [0.9, 0.8, 0.6, 0.4, 0.3, 0.1];
        let ys = [1, 0, 1, 1, 0, 0];
        let c = Confusion::at(&scores, &ys, 0.5);
        assert_eq!(c, Confusion { tp: 2, fp: 1, tn: 2, fn_: 1 });
        assert!((c.precision() - 2.0 / 3.0).abs() < 1e-12);
        assert!((c.recall() - 2.0 / 3.0).abs() < 1e-12);
        assert!((c.f1() - 2.0 / 3.0).abs() < 1e-12);
        assert!((c.accuracy() - 4.0 / 6.0).abs() < 1e-12);
        assert_eq!(Confusion::default().f1(), 0.0);
    }

    #[test]
    fn rule_is_score_greater_or_equal() {
        assert_eq!(Confusion::at(&[0.5], &[1], 0.5).tp, 1);
        assert_eq!(Confusion::at(&[0.4999], &[1], 0.5).fn_, 1);
    }

    #[test]
    fn best_f1_is_a_midpoint_between_the_classes() {
        // Perfectly separable: positives >= 0.7, negatives <= 0.3.
        let scores = [0.95, 0.9, 0.7, 0.3, 0.2, 0.05];
        let ys = [1, 1, 1, 0, 0, 0];
        let (t, f1) = best_f1_threshold(&scores, &ys).expect("positives exist");
        assert_eq!(f1, 1.0);
        assert!((t - 0.5).abs() < 1e-6, "midpoint of 0.7 and 0.3, got {t}");
        assert_eq!(Confusion::at(&scores, &ys, t).f1(), 1.0);
    }

    #[test]
    fn best_f1_matches_brute_force_on_overlapping_scores() {
        let scores = [0.92, 0.85, 0.8, 0.66, 0.6, 0.55, 0.4, 0.35, 0.2, 0.1];
        let ys = [1, 1, 0, 1, 0, 1, 0, 0, 1, 0];
        let (t, f1) = best_f1_threshold(&scores, &ys).expect("positives exist");
        let brute = scores.iter().map(|s| Confusion::at(&scores, &ys, *s).f1()).fold(0.0, f64::max);
        assert!((f1 - brute).abs() < 1e-12, "{f1} vs brute force {brute}");
        assert!((Confusion::at(&scores, &ys, t).f1() - brute).abs() < 1e-12, "selected threshold {t} reproduces the F1");
    }

    #[test]
    fn ties_pick_the_highest_threshold_and_equal_scores_stay_together() {
        // Every score identical: only one candidate, accepts all.
        let (t, _) = best_f1_threshold(&[0.5, 0.5, 0.5], &[1, 0, 1]).expect("positives exist");
        assert_eq!(t, 0.5);
        // All positives: F1 = 1 at the lowest score; ties resolve to the highest such threshold.
        let (t, f1) = best_f1_threshold(&[0.9, 0.6, 0.3], &[1, 1, 1]).expect("positives exist");
        assert_eq!(f1, 1.0);
        assert_eq!(t, 0.3);
    }

    #[test]
    fn no_positives_means_no_threshold() {
        assert!(best_f1_threshold(&[0.1, 0.2], &[0, 0]).is_none());
        assert!(select(&ThresholdCfg::MaxF1OnVal, &[0.1, 0.2], &[0, 0]).is_err());
        assert!(average_precision(&[0.1], &[0]).is_none());
    }

    #[test]
    fn fixed_threshold_is_used_as_given() {
        let t = select(&ThresholdCfg::Fixed { value: 0.8 }, &[], &[]).expect("fixed works without validation rows");
        assert_eq!(t, Thresholds { accept: 0.8, escalate: 0.8, margin: 0.0 });
    }

    #[test]
    fn escalate_is_below_accept_and_reaches_the_recall_target() {
        // 10 positives at 0.9..0.55, accept 0.8 loses the lower ones; escalate must reach 99% recall.
        let scores = [0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.3];
        let ys = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0];
        let t = select(&ThresholdCfg::Fixed { value: 0.8 }, &scores, &ys).expect("selects");
        assert!(t.escalate < t.accept);
        assert_eq!(Confusion::at(&scores, &ys, t.escalate).recall(), 1.0);
        assert!(t.escalate > 0.45, "does not collect negatives it does not need: {}", t.escalate);
    }

    #[test]
    fn average_precision_known_values() {
        assert!((average_precision(&[0.9, 0.8, 0.1], &[1, 1, 0]).expect("ap") - 1.0).abs() < 1e-12);
        // ranking: neg, pos -> precision 0.5 at recall 1.
        assert!((average_precision(&[0.9, 0.8], &[0, 1]).expect("ap") - 0.5).abs() < 1e-12);
    }
}
