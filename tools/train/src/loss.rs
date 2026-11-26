//! Binary cross-entropy on logits with a positive-class weight.
//!
//! The core's `BCEWithLogits` has no class weight, so gp-train owns this loss instead of
//! changing the core. The convention is PyTorch's `pos_weight`: the per-sample loss of a
//! positive is multiplied by `pos_weight`, a negative by 1, and the batch loss is the mean
//! over the samples of the batch (denominator `B`, not the sum of weights):
//!
//! ```text
//! l(z, y) = w_y * ( max(z, 0) - z*y + ln(1 + exp(-|z|)) ),   w_1 = pos_weight, w_0 = 1
//! dl/dz   = w_y * ( sigmoid(z) - y )
//! ```
//!
//! The gradient fed to `Graph::backward` for sample `i` of a batch of `B` is `dl/dz / B`.
//!
//! With `sample_weight: "row"` every sample also carries a row weight `r_i >= 0` (the `w`
//! column of the dataset) and the batch loss is the weighted mean, the denominator being the
//! sum of the row weights instead of `B`:
//!
//! ```text
//! L = sum_i r_i * l(z_i, y_i) / sum_i r_i          dL/dz_i = r_i * dl/dz / sum_i r_i
//! ```
//!
//! `r_i = 1` for every row gives exactly the formulas above. A batch with `sum r = 0` contributes
//! no loss and no gradient and takes no optimizer step (it is as if it were not in the epoch).

/// Numerically stable sigmoid.
pub fn sigmoid(z: f32) -> f32 {
    if z >= 0.0 {
        1.0 / (1.0 + (-z).exp())
    } else {
        let e = z.exp();
        e / (1.0 + e)
    }
}

/// Sigmoid as the model reports it in `golden.score`: evaluated in f64, rounded once to f32.
pub fn sigmoid_f32(z: f32) -> f32 {
    (1.0 / (1.0 + (-f64::from(z)).exp())) as f32
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WeightedBce {
    pub pos_weight: f32,
}

impl WeightedBce {
    pub fn new(pos_weight: f32) -> WeightedBce {
        WeightedBce { pos_weight }
    }

    /// Unweighted loss (`pos_weight = 1`).
    pub fn plain() -> WeightedBce {
        WeightedBce { pos_weight: 1.0 }
    }

    fn weight(&self, y: u8) -> f32 {
        if y == 1 {
            self.pos_weight
        } else {
            1.0
        }
    }

    /// Per-sample weighted loss.
    pub fn loss(&self, logit: f32, y: u8) -> f32 {
        let t = f32::from(y);
        let base = logit.max(0.0) - logit * t + (-logit.abs()).exp().ln_1p();
        self.weight(y) * base
    }

    /// Per-sample gradient with respect to the logit (before the `1/B` batch mean).
    pub fn grad(&self, logit: f32, y: u8) -> f32 {
        self.weight(y) * (sigmoid(logit) - f32::from(y))
    }

    /// Mean weighted loss over `logits` / `ys`.
    pub fn mean_loss(&self, logits: &[f32], ys: &[u8]) -> f32 {
        if logits.is_empty() {
            return 0.0;
        }
        let sum: f64 = logits.iter().zip(ys).map(|(z, y)| f64::from(self.loss(*z, *y))).sum();
        (sum / logits.len() as f64) as f32
    }

    /// Weighted mean loss `sum(w_i * l_i) / sum(w_i)` (`sample_weight: "row"`). With `sum(w) = 0`
    /// the loss is 0 (nothing is being asked of the model), like an empty input.
    pub fn mean_loss_weighted(&self, logits: &[f32], ys: &[u8], w: &[f32]) -> f32 {
        let (mut num, mut den) = (0f64, 0f64);
        for ((z, y), wi) in logits.iter().zip(ys).zip(w) {
            num += f64::from(*wi) * f64::from(self.loss(*z, *y));
            den += f64::from(*wi);
        }
        if den > 0.0 {
            (num / den) as f32
        } else {
            0.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gran_prix::loss::{BCEWithLogits, Loss};
    use gran_prix::Tensor;

    const LOGITS: [f32; 7] = [-12.0, -3.0, -0.4, 0.0, 0.7, 2.5, 15.0];

    #[test]
    fn gradient_matches_finite_differences_for_every_weight() {
        for &w in &[1.0f32, 0.5, 3.0, 12.5] {
            let l = WeightedBce::new(w);
            for &z in &LOGITS {
                for y in [0u8, 1] {
                    let h = 1e-2f64;
                    let num = (f64::from(l.loss((f64::from(z) + h) as f32, y)) - f64::from(l.loss((f64::from(z) - h) as f32, y))) / (2.0 * h);
                    let ana = f64::from(l.grad(z, y));
                    assert!((num - ana).abs() < 2e-3 * (1.0 + ana.abs()), "w={w} z={z} y={y}: numeric {num} vs analytic {ana}");
                }
            }
        }
    }

    #[test]
    fn weight_one_reproduces_the_core_bce_with_logits() {
        let ys = [0u8, 1, 1, 0, 1, 0, 1];
        let logits = Tensor::from_shape_vec(&[7, 1], LOGITS.to_vec()).expect("tensor");
        let targets = Tensor::from_shape_vec(&[7, 1], ys.iter().map(|y| f32::from(*y)).collect()).expect("tensor");
        let core_loss = BCEWithLogits.calculate(&logits, &targets).expect("loss");
        let ours = WeightedBce::plain().mean_loss(&LOGITS, &ys);
        assert!((core_loss - ours).abs() < 1e-5, "{core_loss} vs {ours}");

        let core_grad = BCEWithLogits.gradient(&logits, &targets).expect("grad");
        let core_grad = core_grad.as_slice().expect("slice");
        for i in 0..7 {
            let ours = WeightedBce::plain().grad(LOGITS[i], ys[i]) / 7.0;
            assert!((core_grad[i] - ours).abs() < 1e-6, "i={i}: {} vs {ours}", core_grad[i]);
        }
    }

    /// The defining property of `pos_weight = k`: a positive counts as `k` identical
    /// positives (loss and gradient), a negative is untouched.
    #[test]
    fn pos_weight_k_equals_k_copies_of_each_positive() {
        let k = 3.0f32;
        let weighted = WeightedBce::new(k);
        let plain = WeightedBce::plain();
        for &z in &LOGITS {
            assert!((weighted.loss(z, 1) - 3.0 * plain.loss(z, 1)).abs() < 1e-5);
            assert!((weighted.grad(z, 1) - 3.0 * plain.grad(z, 1)).abs() < 1e-5);
            assert_eq!(weighted.loss(z, 0), plain.loss(z, 0));
            assert_eq!(weighted.grad(z, 0), plain.grad(z, 0));
        }
    }

    #[test]
    fn weighted_mean_loss_is_the_weighted_average() {
        let l = WeightedBce::new(2.0);
        let ys = [0u8, 1, 1, 0, 1, 0, 1];
        let ones = [1.0f32; 7];
        assert_eq!(l.mean_loss_weighted(&LOGITS, &ys, &ones), l.mean_loss(&LOGITS, &ys));
        let w = [0.0f32, 3.0, 1.0, 0.0, 0.0, 2.0, 4.0];
        let (mut num, mut den) = (0f64, 0f64);
        for i in 0..7 {
            num += f64::from(w[i]) * f64::from(l.loss(LOGITS[i], ys[i]));
            den += f64::from(w[i]);
        }
        assert!((f64::from(l.mean_loss_weighted(&LOGITS, &ys, &w)) - num / den).abs() < 1e-6);
        // sum(w) = 0 and empty input: 0, not NaN.
        assert_eq!(l.mean_loss_weighted(&LOGITS, &ys, &[0.0; 7]), 0.0);
        assert_eq!(l.mean_loss_weighted(&[], &[], &[]), 0.0);
    }

    #[test]
    fn extreme_logits_stay_finite() {
        let l = WeightedBce::new(4.0);
        for z in [-200.0f32, 200.0] {
            for y in [0u8, 1] {
                assert!(l.loss(z, y).is_finite() && l.grad(z, y).is_finite());
            }
        }
        assert_eq!(sigmoid(-200.0), 0.0);
        assert_eq!(sigmoid(200.0), 1.0);
    }

    #[test]
    fn sigmoid_variants_agree() {
        for &z in &LOGITS {
            assert!((sigmoid(z) - sigmoid_f32(z)).abs() < 1e-6);
        }
        assert_eq!(sigmoid_f32(0.0), 0.5);
    }
}
