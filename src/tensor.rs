use ndarray::Array2;

/// A 2D Tensor wrapping ndarray's Array2. 
/// For now, we focus on 2D (Batch Size x Features) for simplicity and performance in MLPs.
pub type Tensor = Array2<f32>;

/// Helper trait for common tensor operations.
pub trait TensorOps {
    fn new_zeros(shape: (usize, usize)) -> Self;
    fn new_random(shape: (usize, usize)) -> Self;
}

impl TensorOps for Tensor {
    fn new_zeros(shape: (usize, usize)) -> Self {
        Array2::zeros(shape)
    }

    fn new_random(shape: (usize, usize)) -> Self {
        use ndarray_rand::RandomExt;
        use rand::distributions::Uniform;
        Array2::random(shape, Uniform::new(-1.0, 1.0))
    }
}
