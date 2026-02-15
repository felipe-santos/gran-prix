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
