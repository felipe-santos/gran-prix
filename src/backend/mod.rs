use crate::{Tensor, GPResult};

/// Trait defining the physical execution of operations.
/// This allows us to swap CPU (SIMD/Rayon) for GPU (WGPU/CUDA).
pub trait Backend: Send + Sync + std::fmt::Debug {
    /// Matrix multiplication: a * b (with transpose options). 
    /// Assumes 2D tensors.
    fn matmul_t(&self, a: &Tensor, b: &Tensor, trans_a: bool, trans_b: bool) -> GPResult<Tensor>;

    /// 2D Convolution: [N, Ci, H, W] * [Co, Ci, Kh, Kw] -> [N, Co, Oh, Ow]
    fn conv2d(&self, input: &Tensor, weight: &Tensor, stride: usize, padding: usize) -> GPResult<Tensor>;

    /// 2D Convolution Backward: calculates gradients for input and weight.
    fn conv2d_backward(&self, input: &Tensor, weight: &Tensor, grad_output: &Tensor, stride: usize, padding: usize) -> GPResult<(Tensor, Tensor)>;

    /// Max Pooling 2D
    fn max_pool2d(&self, input: &Tensor, kernel_size: usize, stride: usize) -> GPResult<Tensor>;

    /// Max Pooling 2D Backward
    fn max_pool2d_backward(&self, input: &Tensor, grad_output: &Tensor, kernel_size: usize, stride: usize) -> GPResult<Tensor>;

    fn add(&self, a: &Tensor, b: &Tensor) -> GPResult<Tensor>;
    fn relu(&self, x: &Tensor) -> GPResult<Tensor>;
    fn sigmoid(&self, x: &Tensor) -> GPResult<Tensor>;

    /// ReLU Backward: dL/dX = dL/dY * (Y > 0)
    fn relu_backward(&self, input: &Tensor, grad_output: &Tensor) -> GPResult<Tensor>;
    
    /// Sigmoid Backward: dL/dX = dL/dY * Y * (1 - Y)
    fn sigmoid_backward(&self, output: &Tensor, grad_output: &Tensor) -> GPResult<Tensor>;

    /// Fused kernel: ReLU(A + B)
    /// Goal: Minimize memory bandwidth by doing addition and activation in one sweep.
    fn add_relu(&self, a: &Tensor, b: &Tensor) -> GPResult<Tensor>;

    /// Updates a parameter tensor using its gradient and a learning rate.
    /// Standard SGD update: param = param - lr * grad
    /// Sums the tensor over the specified axes.
    fn reduce_sum(&self, input: &Tensor, axes: &[usize], keep_dims: bool) -> GPResult<Tensor>;

    /// Updates a parameter tensor using its gradient and a learning rate.
    /// Standard SGD update: param = param - lr * grad
    fn update_parameter(&self, param: &mut Tensor, grad: &Tensor, learning_rate: f32) -> GPResult<()>;
}

pub mod cpu;
pub mod cuda;
