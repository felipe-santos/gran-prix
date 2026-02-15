use crate::Tensor;
use anyhow::Result;

/// Trait defining the physical execution of operations.
/// This allows us to swap CPU (SIMD/Rayon) for GPU (WGPU/CUDA).
pub trait Backend: Send + Sync {
    fn name(&self) -> &str;
    
    /// Matrix multiplication with transposition options:
    /// matmul_t(A, B, trans_a, trans_b) -> A^T * B, A * B^T, etc.
    fn matmul_t(&self, a: &Tensor, b: &Tensor, trans_a: bool, trans_b: bool) -> Result<Tensor>;

    /// Element-wise addition with broadcast: C = A + B
    fn add(&self, a: &Tensor, b: &Tensor) -> Result<Tensor>;
    
    /// Element-wise Sigmoid activation
    fn sigmoid(&self, x: &Tensor) -> Result<Tensor>;
    
    /// Element-wise ReLU activation
    fn relu(&self, x: &Tensor) -> Result<Tensor>;

    /// Fused kernel: ReLU(A + B)
    /// Goal: Minimize memory bandwidth by doing addition and activation in one sweep.
    fn add_relu(&self, a: &Tensor, b: &Tensor) -> Result<Tensor>;
}

pub mod cpu;
