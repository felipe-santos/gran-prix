//! z-score normalization fitted on the TRAIN split only (contract: `x' = (x - mean) / (std + eps)`,
//! applied to the extractor output before the network) and the per-feature training range
//! used for out-of-distribution detection.

use crate::dataset::Rows;
use crate::error::Result;
use crate::invalid;

/// eps of the contract formula. Stored in `feature_spec.normalization.eps`.
pub const EPS: f64 = 1e-6;

/// Standard deviations below this are considered zero (see [`ZScore::fit`]).
const ZERO_STD: f64 = 1e-12;

#[derive(Debug, Clone, PartialEq)]
pub struct ZScore {
    pub mean: Vec<f32>,
    pub std: Vec<f32>,
    pub eps: f64,
    /// Features whose training variance was zero (their `std` was stored as 1).
    pub constant_features: Vec<usize>,
}

/// Per-feature normalization of a model.
#[derive(Debug, Clone, PartialEq)]
pub enum Normalizer {
    None,
    ZScore(ZScore),
}

impl ZScore {
    /// Fits mean and population standard deviation (ddof = 0) over the rows, in f64, in row
    /// order (deterministic), then stores them as float32 as the contract requires.
    ///
    /// A feature that is constant in the training split has `std = 0`; the contract formula
    /// would then divide any deviation seen at inference by `eps` (1e-6) and explode. Such
    /// features are stored with `std = 1`, which makes them a plain mean shift (the value
    /// seen in training maps to 0). They are listed in `constant_features`.
    pub fn fit(rows: &Rows) -> Result<ZScore> {
        let n = rows.len();
        if n == 0 {
            return Err(invalid!("cannot fit the normalization: the train split is empty after filtering"));
        }
        let dim = rows.dim;
        let mut mean = vec![0f64; dim];
        for i in 0..n {
            for (m, v) in mean.iter_mut().zip(rows.row(i)) {
                *m += f64::from(*v);
            }
        }
        for m in &mut mean {
            *m /= n as f64;
        }
        let mut var = vec![0f64; dim];
        for i in 0..n {
            for ((s, m), v) in var.iter_mut().zip(&mean).zip(rows.row(i)) {
                let d = f64::from(*v) - m;
                *s += d * d;
            }
        }
        let mut constant_features = Vec::new();
        let std: Vec<f32> = var
            .iter()
            .enumerate()
            .map(|(j, s)| {
                let sd = (s / n as f64).sqrt();
                if sd < ZERO_STD {
                    constant_features.push(j);
                    1.0
                } else {
                    sd as f32
                }
            })
            .collect();
        Ok(ZScore { mean: mean.iter().map(|m| *m as f32).collect(), std, eps: EPS, constant_features })
    }

    fn apply(&self, x: &[f32], out: &mut [f32]) {
        for (j, o) in out.iter_mut().enumerate() {
            // Computed in f64 and rounded once to f32: what a JS consumer does.
            let v = (f64::from(x[j]) - f64::from(self.mean[j])) / (f64::from(self.std[j]) + self.eps);
            *o = v as f32;
        }
    }
}

impl Normalizer {
    /// Normalizes one row into `out` (same length).
    pub fn apply_row(&self, x: &[f32], out: &mut [f32]) {
        match self {
            Normalizer::None => out.copy_from_slice(x),
            Normalizer::ZScore(z) => z.apply(x, out),
        }
    }

    /// Normalizes a row-major matrix.
    pub fn apply_matrix(&self, x: &[f32], dim: usize) -> Vec<f32> {
        let mut out = vec![0f32; x.len()];
        for (src, dst) in x.chunks_exact(dim).zip(out.chunks_exact_mut(dim)) {
            self.apply_row(src, dst);
        }
        out
    }
}

/// Per-feature `[min, max]` of the rows (the `ood` range of `feature_spec`).
pub fn feature_range(rows: &Rows) -> Result<(Vec<f32>, Vec<f32>)> {
    if rows.is_empty() {
        return Err(invalid!("cannot compute the feature range of an empty split"));
    }
    let mut lo = rows.row(0).to_vec();
    let mut hi = lo.clone();
    for i in 1..rows.len() {
        for (j, v) in rows.row(i).iter().enumerate() {
            lo[j] = lo[j].min(*v);
            hi[j] = hi[j].max(*v);
        }
    }
    Ok((lo, hi))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(x: Vec<f32>, dim: usize) -> Rows {
        let n = x.len() / dim;
        Rows {
            dim,
            x,
            y: vec![0; n],
            conf: vec![1.0; n],
            source: vec!["human".into(); n],
            group: vec!["g".into(); n],
            unit: (0..n as u64).collect(),
            w: Vec::new(),
        }
    }

    #[test]
    fn fits_mean_and_population_std() {
        // column 0: 1,2,3,4 -> mean 2.5, population variance 1.25; column 1: 10,10,20,20 -> mean 15, std 5.
        let r = rows(vec![1.0, 10.0, 2.0, 10.0, 3.0, 20.0, 4.0, 20.0], 2);
        let z = ZScore::fit(&r).expect("fits");
        assert_eq!(z.mean, vec![2.5, 15.0]);
        assert!((f64::from(z.std[0]) - 1.25f64.sqrt()).abs() < 1e-6);
        assert_eq!(z.std[1], 5.0);
        assert!(z.constant_features.is_empty());
    }

    #[test]
    fn applies_the_contract_formula() {
        let z = ZScore { mean: vec![2.0], std: vec![4.0], eps: 1e-6, constant_features: vec![] };
        let mut out = [0f32];
        Normalizer::ZScore(z).apply_row(&[10.0], &mut out);
        let expected = ((10.0f64 - 2.0) / (4.0 + 1e-6)) as f32;
        assert_eq!(out[0], expected);
    }

    #[test]
    fn constant_feature_gets_unit_std_instead_of_dividing_by_eps() {
        let r = rows(vec![3.0, 1.0, 3.0, 2.0, 3.0, 3.0], 2);
        let z = ZScore::fit(&r).expect("fits");
        assert_eq!(z.constant_features, vec![0]);
        assert_eq!(z.std[0], 1.0);
        let mut out = [0f32; 2];
        Normalizer::ZScore(z).apply_row(&[3.5, 2.0], &mut out);
        assert!((out[0] - 0.5).abs() < 1e-5, "unseen deviation stays small: {}", out[0]);
    }

    #[test]
    fn fit_uses_only_the_rows_it_is_given_and_errors_on_empty() {
        let r = rows(vec![0.0, 2.0], 1);
        let all = ZScore::fit(&r).expect("fits");
        assert_eq!(all.mean, vec![1.0]);
        assert!(ZScore::fit(&rows(vec![], 1)).is_err());
    }

    #[test]
    fn none_is_the_identity_and_matrix_apply_is_row_wise() {
        let mut out = [0f32; 2];
        Normalizer::None.apply_row(&[1.5, -2.0], &mut out);
        assert_eq!(out, [1.5, -2.0]);
        let z = Normalizer::ZScore(ZScore { mean: vec![1.0, 0.0], std: vec![1.0, 2.0], eps: 0.0, constant_features: vec![] });
        assert_eq!(z.apply_matrix(&[2.0, 4.0, 3.0, 8.0], 2), vec![1.0, 2.0, 2.0, 4.0]);
    }

    #[test]
    fn feature_range_is_min_max() {
        let r = rows(vec![1.0, 5.0, -1.0, 7.0, 3.0, 6.0], 2);
        let (lo, hi) = feature_range(&r).expect("range");
        assert_eq!(lo, vec![-1.0, 5.0]);
        assert_eq!(hi, vec![3.0, 7.0]);
    }
}
