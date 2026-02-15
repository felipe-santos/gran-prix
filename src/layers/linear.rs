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
            weights: weights.into_dyn().into(),
            biases: biases.into_dyn().into(),
            grad_weights: grad_weights.into_dyn().into(),
            grad_biases: grad_biases.into_dyn().into(),
            name: name.to_string(),
        }
    }
}

#[typetag::serde]
impl Layer for Linear {
    fn forward(&self, input: &Tensor) -> Tensor {
        let x = input.view().into_dimensionality::<ndarray::Ix2>().unwrap();
        let w = self.weights.view().into_dimensionality::<ndarray::Ix2>().unwrap();
        let b = self.biases.view().into_dimensionality::<ndarray::Ix2>().unwrap();
        
        (x.dot(&w) + b).into_dyn().into()
    }

    fn backward(&mut self, input: &Tensor, grad_output: &Tensor) -> Tensor {
        let x = input.view().into_dimensionality::<ndarray::Ix2>().unwrap();
        let grad_out = grad_output.view().into_dimensionality::<ndarray::Ix2>().unwrap();
        let w = self.weights.view().into_dimensionality::<ndarray::Ix2>().unwrap();

        // dL/dW = input^T . grad_output
        let gw = x.t().dot(&grad_out);
        self.grad_weights = gw.into_dyn().into();
        
        // dL/dB = sum of grad_output across batch (rows)
        self.grad_biases = grad_output.view().sum_axis(ndarray::Axis(0)).insert_axis(ndarray::Axis(0)).into_dyn().into();
        
        // dL/dX = grad_output . W^T
        grad_out.dot(&w.t()).into_dyn().into()
    }

    fn update(&mut self, learning_rate: f32) {
        self.weights -= &(&self.grad_weights * learning_rate);
        self.biases -= &(&self.grad_biases * learning_rate);
    }

    fn name(&self) -> &str {
        &self.name
    }
}
