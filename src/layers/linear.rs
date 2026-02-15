use crate::Tensor;
use crate::Layer;
use ndarray::Array2;
use ndarray_rand::RandomExt;
use ndarray_rand::rand_distr::StandardNormal;

use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize)]
pub struct Linear {
    pub weights: Tensor,
    pub biases: Tensor,
    pub grad_weights: Tensor,
    pub grad_biases: Tensor,
    name: String,
}

impl Linear {
    pub fn new(input_dim: usize, output_dim: usize, name: &str) -> Self {
        let weights = Array2::random((input_dim, output_dim), StandardNormal) * 0.1;
        let biases = Array2::zeros((1, output_dim));
        let grad_weights = Array2::zeros((input_dim, output_dim));
        let grad_biases = Array2::zeros((1, output_dim));

        Self {
            weights,
            biases,
            grad_weights,
            grad_biases,
            name: name.to_string(),
        }
    }
}

#[typetag::serde]
impl Layer for Linear {
    fn forward(&self, input: &Tensor) -> Tensor {
        input.dot(&self.weights) + &self.biases
    }

    fn backward(&mut self, input: &Tensor, grad_output: &Tensor) -> Tensor {
        // dL/dW = input^T . grad_output
        self.grad_weights = input.t().dot(grad_output);
        
        // dL/dB = sum of grad_output across batch (rows)
        self.grad_biases = grad_output.sum_axis(ndarray::Axis(0)).insert_axis(ndarray::Axis(0));
        
        // Return gradient with respect to input for backprop
        // dL/dX = grad_output . W^T
        grad_output.dot(&self.weights.t())
    }

    fn update(&mut self, learning_rate: f32) {
        self.weights -= &(&self.grad_weights * learning_rate);
        self.biases -= &(&self.grad_biases * learning_rate);
    }

    fn name(&self) -> &str {
        &self.name
    }
}
