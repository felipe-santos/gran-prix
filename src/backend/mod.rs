use crate::{Tensor, GPResult};

/// Trait defining the physical execution of operations.
/// This allows us to swap CPU (SIMD/Rayon) for GPU (WGPU/CUDA).
pub trait Backend: Send + Sync + std::fmt::Debug {
    /// Matrix multiplication: a * b (with transpose options). 
    /// Assumes 2D tensors.
    fn matmul_t(&self, a: &Tensor, b: &Tensor, trans_a: bool, trans_b: bool) -> GPResult<Tensor>;
    fn matmul_into(&self, a: &Tensor, b: &Tensor, trans_a: bool, trans_b: bool, out: &mut Tensor) -> GPResult<()>;

    fn matmul(&self, a: &Tensor, b: &Tensor) -> GPResult<Tensor> {
        self.matmul_t(a, b, false, false)
    }

    /// MatMul backward: returns (grad_a, grad_b)
    fn matmul_backward(&self, a: &Tensor, b: &Tensor, grad_output: &Tensor) -> GPResult<Vec<Tensor>> {
        // dL/dA = dL/dY * B^T
        // dL/dB = A^T * dL/dY
        let grad_a = self.matmul_t(grad_output, b, false, true)?;
        let grad_b = self.matmul_t(a, grad_output, true, false)?;
        Ok(vec![grad_a, grad_b])
    }

    /// 2D Convolution: [N, Ci, H, W] * [Co, Ci, Kh, Kw] -> [N, Co, Oh, Ow]
    fn conv2d(&self, input: &Tensor, weight: &Tensor, stride: usize, padding: usize) -> GPResult<Tensor>;

    /// FFT-based 2D Convolution (Optimized for large kernels)
    fn fft_conv2d(&self, input: &Tensor, weight: &Tensor, stride: usize, padding: usize) -> GPResult<Tensor> {
        // Default fallback to naive convolution
        self.conv2d(input, weight, stride, padding)
    }

    /// 2D Convolution Backward: calculates gradients for input and weight.
    fn conv2d_backward(&self, input: &Tensor, weight: &Tensor, grad_output: &Tensor, stride: usize, padding: usize) -> GPResult<(Tensor, Tensor)>;

    /// Max Pooling 2D
    fn max_pool2d(&self, input: &Tensor, kernel_size: usize, stride: usize) -> GPResult<Tensor>;

    /// Max Pooling 2D Backward
    fn max_pool2d_backward(&self, input: &Tensor, grad_output: &Tensor, kernel_size: usize, stride: usize) -> GPResult<Tensor>;

    fn add(&self, a: &Tensor, b: &Tensor) -> GPResult<Tensor>;
    fn add_into(&self, a: &Tensor, b: &Tensor, out: &mut Tensor) -> GPResult<()>;
    fn relu(&self, x: &Tensor) -> GPResult<Tensor>;
    fn relu_inplace(&self, x: &mut Tensor) -> GPResult<()>;
    fn sigmoid(&self, x: &Tensor) -> GPResult<Tensor>;
    fn sigmoid_inplace(&self, x: &mut Tensor) -> GPResult<()>;
    fn tanh(&self, x: &Tensor) -> GPResult<Tensor>;
    fn tanh_inplace(&self, x: &mut Tensor) -> GPResult<()>;

    /// ReLU Backward: dL/dX = dL/dY * (Y > 0)
    fn relu_backward(&self, input: &Tensor, grad_output: &Tensor) -> GPResult<Tensor>;
    
    /// Sigmoid Backward: dL/dX = dL/dY * Y * (1 - Y)
    fn sigmoid_backward(&self, output: &Tensor, grad_output: &Tensor) -> GPResult<Tensor>;

    /// Tanh Backward: dL/dX = dL/dY * (1 - Y^2)
    fn tanh_backward(&self, output: &Tensor, grad_output: &Tensor) -> GPResult<Tensor>;

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
