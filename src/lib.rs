pub mod layers;
pub mod activations;
pub mod optim;
pub mod loss;
pub mod models;
pub mod tensor;
pub mod errors;

pub use tensor::Tensor;
pub use errors::GPResult;

/// Base trait for all neural network layers.
#[typetag::serde]
pub trait Layer: Send + Sync {
    /// Forward pass: transforms input tensor into output tensor.
    fn forward(&self, input: &Tensor) -> Tensor;
    
    /// Backward pass: computes gradients with respect to input and parameters.
    /// Returns the gradient with respect to the input.
    fn backward(&mut self, input: &Tensor, grad_output: &Tensor) -> Tensor;
    
    /// Updates parameters using the provided learning rate.
    fn update(&mut self, learning_rate: f32);

    /// Returns the name of the layer for debugging.
    fn name(&self) -> &str;
}
