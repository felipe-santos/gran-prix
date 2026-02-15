use crate::Tensor;
use anyhow::Result;

/// Trait defining the physical execution of operations.
/// This allows us to swap CPU (SIMD/Rayon) for GPU (WGPU/CUDA).
pub trait Backend: Send + Sync + std::fmt::Debug {
    /// Matrix multiplication: a * b (with transpose options). 
    /// Assumes 2D tensors.
    fn matmul_t(&self, a: &Tensor, b: &Tensor, trans_a: bool, trans_b: bool) -> Result<Tensor>;

    /// 2D Convolution: [N, Ci, H, W] * [Co, Ci, Kh, Kw] -> [N, Co, Oh, Ow]
    fn conv2d(&self, input: &Tensor, weight: &Tensor, stride: usize, padding: usize) -> Result<Tensor>;

    /// Max Pooling 2D
    fn max_pool2d(&self, input: &Tensor, kernel_size: usize, stride: usize) -> Result<Tensor>;

    fn add(&self, a: &Tensor, b: &Tensor) -> Result<Tensor>;
    fn relu(&self, x: &Tensor) -> Result<Tensor>;
    fn sigmoid(&self, x: &Tensor) -> Result<Tensor>;

    /// Fused kernel: ReLU(A + B)
    /// Goal: Minimize memory bandwidth by doing addition and activation in one sweep.
    fn add_relu(&self, a: &Tensor, b: &Tensor) -> Result<Tensor>;
}

pub mod cpu;
