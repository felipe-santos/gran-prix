use crate::layers::Linear;

pub trait Optimizer {
    fn step(&self, layer: &mut Linear);
}

pub struct SGD {
    pub learning_rate: f32,
}

impl SGD {
    pub fn new(learning_rate: f32) -> Self {
        Self { learning_rate }
    }
}

impl Optimizer for SGD {
    fn step(&self, layer: &mut Linear) {
        layer.weights -= &(&layer.grad_weights * self.learning_rate);
        layer.biases -= &(&layer.grad_biases * self.learning_rate);
    }
}
