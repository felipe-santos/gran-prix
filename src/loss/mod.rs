use crate::Tensor;

pub trait Loss {
    fn calculate(&self, predicted: &Tensor, target: &Tensor) -> f32;
    fn gradient(&self, predicted: &Tensor, target: &Tensor) -> Tensor;
}

pub struct MSE;

impl Loss for MSE {
    fn calculate(&self, predicted: &Tensor, target: &Tensor) -> f32 {
        let diff = predicted - target;
        (&diff * &diff).mean().unwrap_or(0.0)
    }

    fn gradient(&self, predicted: &Tensor, target: &Tensor) -> Tensor {
        let n = predicted.len() as f32;
        let diff = predicted - target;
        &(2.0 * &diff) / n
    }
}

pub struct BinaryCrossEntropy;

impl Loss for BinaryCrossEntropy {
    fn calculate(&self, predicted: &Tensor, target: &Tensor) -> f32 {
        // BCE = -1/N * sum(y * log(p) + (1-y) * log(1-p))
        // We add a small epsilon to avoid log(0)
        let epsilon = 1e-7;
        let p = predicted.mapv(|x: f32| x.clamp(epsilon, 1.0 - epsilon));
        
        let term1 = target * &p.mapv(|x: f32| x.ln());
        // For term2, (1.0 - &p) creates a temporary Tensor.
        let one_minus_p = 1.0 - &p; 
        let term2 = (1.0 - target) * &one_minus_p.mapv(|x: f32| x.ln());
        
        let sum: Tensor = &term1 + &term2;
        let mean = sum.mean().unwrap_or(0.0);
        -mean
    }

    fn gradient(&self, predicted: &Tensor, target: &Tensor) -> Tensor {
        let n = predicted.len() as f32;
        let diff = predicted - target;
        &diff / n
    }
}

pub struct BCEWithLogits;

impl Loss for BCEWithLogits {
    fn calculate(&self, logits: &Tensor, target: &Tensor) -> f32 {
        // BCEWithLogits = max(x, 0) - x*y + log(1 + e^(-|x|))
        let max_val = logits.mapv(|x: f32| if x > 0.0 { x } else { 0.0 });
        let neg_abs = logits.mapv(|x: f32| -x.abs());
        let log_term = neg_abs.mapv(|x: f32| (1.0 + x.exp()).ln());
        
        // term = max_val - x*y + log_term
        let term = &max_val - &(logits * target) + &log_term;
        term.mean().unwrap_or(0.0)
    }

    fn gradient(&self, logits: &Tensor, target: &Tensor) -> Tensor {
        // Gradient of BCEWithLogits w.r.t logits is simply: sigmoid(logits) - target
        let sigmoid = logits.mapv(|x: f32| 1.0 / (1.0 + (-x).exp()));
        let n = logits.len() as f32;
        let diff = sigmoid - target;
        &diff / n
    }
}
