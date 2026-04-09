//! Loss functions for training neural networks.
//!
//! All loss functions implement the [`Loss`] trait with fallible return types
//! to properly propagate device errors (e.g., CUDA tensor on CPU-only loss).

use crate::{Tensor, GPResult};

/// Trait for loss functions.
///
/// Both `calculate` and `gradient` return `GPResult` to properly handle
/// device mismatches and shape errors instead of panicking.
pub trait Loss {
    /// Computes the scalar loss value.
    fn calculate(&self, predicted: &Tensor, target: &Tensor) -> GPResult<f32>;
    /// Computes the gradient of the loss w.r.t. the predicted values.
    fn gradient(&self, predicted: &Tensor, target: &Tensor) -> GPResult<Tensor>;
}

/// Mean Squared Error: `1/N * sum((predicted - target)^2)`.
pub struct MSE;

impl Loss for MSE {
    fn calculate(&self, predicted: &Tensor, target: &Tensor) -> GPResult<f32> {
        let diff = predicted - target;
        (&diff * &diff).mean()
    }

    fn gradient(&self, predicted: &Tensor, target: &Tensor) -> GPResult<Tensor> {
        let n = predicted.len() as f32;
        let diff = predicted - target;
        Ok(&(2.0 * &diff) / n)
    }
}

/// Binary Cross-Entropy (expects probabilities in [0, 1]).
pub struct BinaryCrossEntropy;

impl Loss for BinaryCrossEntropy {
    fn calculate(&self, predicted: &Tensor, target: &Tensor) -> GPResult<f32> {
        let epsilon = 1e-7;
        let p = predicted.mapv(|x: f32| x.clamp(epsilon, 1.0 - epsilon));
        let term1 = target * &p.mapv(|x: f32| x.ln());
        let one_minus_p = 1.0 - &p;
        let term2 = (1.0 - target) * &one_minus_p.mapv(|x: f32| x.ln());
        let sum: Tensor = &term1 + &term2;
        Ok(-sum.mean()?)
    }

    fn gradient(&self, predicted: &Tensor, target: &Tensor) -> GPResult<Tensor> {
        let n = predicted.len() as f32;
        let diff = predicted - target;
        Ok(&diff / n)
    }
}

/// Binary Cross-Entropy with logits (numerically stable).
///
/// Expects raw logits (pre-sigmoid). Applies sigmoid internally.
pub struct BCEWithLogits;

impl Loss for BCEWithLogits {
    fn calculate(&self, logits: &Tensor, target: &Tensor) -> GPResult<f32> {
        let max_val = logits.mapv(|x: f32| if x > 0.0 { x } else { 0.0 });
        let neg_abs = logits.mapv(|x: f32| -x.abs());
        let log_term = neg_abs.mapv(|x: f32| (1.0 + x.exp()).ln());
        let term = &max_val - &(logits * target) + &log_term;
        term.mean()
    }

    fn gradient(&self, logits: &Tensor, target: &Tensor) -> GPResult<Tensor> {
        let sigmoid = logits.mapv(|x: f32| 1.0 / (1.0 + (-x).exp()));
        let n = logits.len() as f32;
        let diff = sigmoid - target;
        Ok(&diff / n)
    }
}

/// Categorical Cross-Entropy (expects softmax probabilities + one-hot targets).
pub struct CategoricalCrossEntropy;

impl Loss for CategoricalCrossEntropy {
    fn calculate(&self, predicted: &Tensor, target: &Tensor) -> GPResult<f32> {
        let eps = 1e-7f32;
        let p = predicted.as_slice()?;
        let t = target.as_slice()?;
        let n = predicted.shape()[0] as f32;

        let mut sum = 0.0f32;
        for (&pv, &tv) in p.iter().zip(t.iter()) {
            if tv > 0.0 {
                sum -= tv * pv.max(eps).ln();
            }
        }
        Ok(sum / n)
    }

    fn gradient(&self, predicted: &Tensor, target: &Tensor) -> GPResult<Tensor> {
        let eps = 1e-7f32;
        let n = predicted.shape()[0] as f32;
        let p = predicted.as_slice()?;
        let t = target.as_slice()?;

        let grad_data: Vec<f32> = p.iter().zip(t.iter())
            .map(|(&pv, &tv)| -tv / pv.max(eps) / n)
            .collect();

        Tensor::from_shape_vec(predicted.shape(), grad_data)
    }
}

/// Cross-Entropy with logits (numerically stable, for multi-class).
///
/// Combines log-softmax + NLL in one step. Expects raw logits and one-hot targets.
/// Equivalent to PyTorch's `CrossEntropyLoss` with one-hot targets.
pub struct CrossEntropyWithLogits;

impl Loss for CrossEntropyWithLogits {
    fn calculate(&self, logits: &Tensor, target: &Tensor) -> GPResult<f32> {
        let shape = logits.shape();
        let rows = shape[0];
        let cols = shape[1];
        let x = logits.as_slice()?;
        let t = target.as_slice()?;

        let mut total = 0.0f32;
        for r in 0..rows {
            let rs = r * cols;
            let row = &x[rs..rs + cols];
            let max_val = row.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
            let sum_exp: f32 = row.iter().map(|&v| (v - max_val).exp()).sum::<f32>();
            let log_sum_exp: f32 = sum_exp.max(1e-10).ln();

            for c in 0..cols {
                if t[rs + c] > 0.0 {
                    total -= t[rs + c] * ((row[c] - max_val) - log_sum_exp);
                }
            }
        }
        Ok(total / rows as f32)
    }

    fn gradient(&self, logits: &Tensor, target: &Tensor) -> GPResult<Tensor> {
        let shape = logits.shape();
        let rows = shape[0];
        let cols = shape[1];
        let x = logits.as_slice()?;
        let t = target.as_slice()?;
        let n = rows as f32;

        let mut grad = vec![0.0f32; rows * cols];
        for r in 0..rows {
            let rs = r * cols;
            let row = &x[rs..rs + cols];
            let max_val = row.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
            let mut sum = 0.0f32;
            for c in 0..cols {
                let e = (row[c] - max_val).exp();
                grad[rs + c] = e;
                sum += e;
            }
            let safe_sum = if sum > 0.0 { sum } else { 1e-10 };
            for c in 0..cols {
                grad[rs + c] = (grad[rs + c] / safe_sum - t[rs + c]) / n;
            }
        }

        Tensor::from_shape_vec(shape, grad)
    }
}
