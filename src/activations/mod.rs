use crate::{Tensor, Layer};

use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize)]
pub struct ReLU;
#[derive(Serialize, Deserialize)]
pub struct Sigmoid;

#[typetag::serde]
impl Layer for ReLU {
    fn forward(&self, input: &Tensor) -> Tensor {
        input.mapv(|x| if x > 0.0 { x } else { 0.0 })
    }

    fn backward(&mut self, input: &Tensor, grad_output: &Tensor) -> Tensor {
        let mut grad_input = grad_output.clone();
        for (gi, &i) in grad_input.iter_mut().zip(input.iter()) {
            if i <= 0.0 {
                *gi = 0.0;
            }
        }
        grad_input
    }

    fn update(&mut self, _learning_rate: f32) {}

    fn name(&self) -> &str {
        "ReLU"
    }
}

#[typetag::serde]
impl Layer for Sigmoid {
    fn forward(&self, input: &Tensor) -> Tensor {
        input.mapv(|x| 1.0 / (1.0 + (-x).exp()))
    }

    fn backward(&mut self, input: &Tensor, grad_output: &Tensor) -> Tensor {
        let output = self.forward(input);
        grad_output * &output * (1.0 - &output)
    }

    fn update(&mut self, _learning_rate: f32) {}

    fn name(&self) -> &str {
        "Sigmoid"
    }
}
