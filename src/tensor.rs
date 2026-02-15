use ndarray::{ArrayD, IxDyn};

/// An N-Dimensional Tensor wrapping ndarray's ArrayD.
/// Now supports 2D for MLPs and 4D for CNNs.
pub type Tensor = ArrayD<f32>;

/// Helper trait for common tensor operations.
pub trait TensorOps {
    fn new_zeros(shape: &[usize]) -> Self;
    fn new_random(shape: &[usize]) -> Self;
}

impl TensorOps for Tensor {
    fn new_zeros(shape: &[usize]) -> Self {
        ArrayD::zeros(IxDyn(shape))
    }

    fn new_random(shape: &[usize]) -> Self {
        use ndarray_rand::RandomExt;
        use rand::distributions::Uniform;
        ArrayD::random(IxDyn(shape), Uniform::new(-1.0, 1.0))
    }
}
