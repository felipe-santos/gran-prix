use crate::{Tensor, Layer};
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize)]
pub struct Sequential {
    layers: Vec<Box<dyn Layer>>,
    #[serde(skip)]
    inputs: Vec<Tensor>,
}

impl Sequential {
    pub fn new() -> Self {
        Self {
            layers: Vec::new(),
            inputs: Vec::new(),
        }
    }

    pub fn add<L: Layer + 'static>(&mut self, layer: L) {
        self.layers.push(Box::new(layer));
    }

    pub fn forward(&mut self, input: Tensor) -> Tensor {
        self.inputs.clear();
        let mut current_input = input;
        
        for layer in &self.layers {
            self.inputs.push(current_input.clone());
            current_input = layer.forward(&current_input);
        }
        
        current_input
    }

    pub fn backward(&mut self, grad_output: Tensor) -> Tensor {
        let mut current_grad = grad_output;
        
        for (layer, input) in self.layers.iter_mut().rev().zip(self.inputs.iter().rev()) {
            current_grad = layer.backward(input, &current_grad);
        }
        
        current_grad
    }

    pub fn update(&mut self, learning_rate: f32) {
        for layer in &mut self.layers {
            layer.update(learning_rate);
        }
    }
}
