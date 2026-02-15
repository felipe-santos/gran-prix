use super::{Tensor, Storage};
use crate::{GPError, Device};
use ndarray::{ArrayD, IxDyn};
#[cfg(feature = "cuda")]
use ndarray_rand::RandomExt;
#[cfg(feature = "cuda")]
use rand::distributions::Uniform;

// Operator Overloading for CPU Tensors
impl std::ops::Add for &Tensor {
    type Output = Tensor;
    fn add(self, rhs: Self) -> Self::Output {
        match (&self.storage, &rhs.storage) {
            (Storage::Cpu(a), Storage::Cpu(b)) => (a + b).into(),
            #[cfg(feature = "cuda")]
            _ => panic!("Binary operations on non-CPU tensors not yet implemented or mismatched devices."),
        }
    }
}

impl std::ops::Sub for &Tensor {
    type Output = Tensor;
    fn sub(self, rhs: Self) -> Self::Output {
        match (&self.storage, &rhs.storage) {
            (Storage::Cpu(a), Storage::Cpu(b)) => (a - b).into(),
            #[cfg(feature = "cuda")]
            _ => panic!("Binary operations on non-CPU tensors not yet implemented or mismatched devices."),
        }
    }
}

impl std::ops::Sub<Tensor> for Tensor {
    type Output = Tensor;
    fn sub(self, rhs: Tensor) -> Self::Output {
        &self - &rhs
    }
}

impl std::ops::Sub<&Tensor> for f32 {
    type Output = Tensor;
    fn sub(self, rhs: &Tensor) -> Self::Output {
        match &rhs.storage {
            (Storage::Cpu(a)) => (self - a).into(),
            #[cfg(feature = "cuda")]
            _ => panic!("Scalar subtraction on non-CPU tensors not yet implemented."),
        }
    }
}

impl std::ops::Mul<f32> for &Tensor {
    type Output = Tensor;
    fn mul(self, rhs: f32) -> Self::Output {
        match &self.storage {
            (Storage::Cpu(a)) => (a * rhs).into(),
            #[cfg(feature = "cuda")]
            _ => panic!("Scalar multiplication on non-CPU tensors not yet implemented."),
        }
    }
}

impl std::ops::Mul<&Tensor> for f32 {
    type Output = Tensor;
    fn mul(self, rhs: &Tensor) -> Self::Output {
        rhs * self
    }
}

impl std::ops::Mul<&Tensor> for &Tensor {
    type Output = Tensor;
    fn mul(self, rhs: &Tensor) -> Self::Output {
        match (&self.storage, &rhs.storage) {
            (Storage::Cpu(a), Storage::Cpu(b)) => (a * b).into(),
            #[cfg(feature = "cuda")]
            _ => panic!("Element-wise multiplication on non-CPU tensors not yet implemented."),
        }
    }
}

impl std::ops::Div<f32> for &Tensor {
    type Output = Tensor;
    fn div(self, rhs: f32) -> Self::Output {
        match &self.storage {
            (Storage::Cpu(a)) => (a / rhs).into(),
            #[cfg(feature = "cuda")]
            _ => panic!("Scalar division on non-CPU tensors not yet implemented."),
        }
    }
}

impl std::ops::SubAssign<&Tensor> for Tensor {
    fn sub_assign(&mut self, rhs: &Tensor) {
        match (&mut self.storage, &rhs.storage) {
            (Storage::Cpu(a), Storage::Cpu(b)) => *a -= b,
            #[cfg(feature = "cuda")]
            _ => panic!("In-place operations on non-CPU tensors not yet implemented or mismatched devices."),
        }
    }
}

impl std::ops::AddAssign<&Tensor> for Tensor {
    fn add_assign(&mut self, rhs: &Tensor) {
        match (&mut self.storage, &rhs.storage) {
            (Storage::Cpu(a), Storage::Cpu(b)) => *a += b,
            #[cfg(feature = "cuda")]
            _ => panic!("In-place operations on non-CPU tensors not yet implemented or mismatched devices."),
        }
    }
}

impl PartialEq for Tensor {
    fn eq(&self, other: &Self) -> bool {
        match (&self.storage, &other.storage) {
            (Storage::Cpu(a), Storage::Cpu(b)) => a == b,
            #[cfg(feature = "cuda")]
            _ => panic!("PartialEq comparison involving CUDA tensors not yet implemented"),
        }
    }
}

/// Helper trait for common tensor operations.
pub trait TensorOps {
    fn new_zeros(shape: &[usize]) -> Self;
    fn new_random(shape: &[usize]) -> Self;
    fn mapv<F>(&self, f: F) -> Self where F: Fn(f32) -> f32 + Sync + Send;
}

impl TensorOps for Tensor {
    fn new_zeros(shape: &[usize]) -> Self {
        ArrayD::zeros(IxDyn(shape)).into()
    }

    fn new_random(shape: &[usize]) -> Self {
        use ndarray_rand::RandomExt;
        use rand::distributions::Uniform;
        ArrayD::random(IxDyn(shape), Uniform::new(-1.0, 1.0)).into()
    }

    fn mapv<F>(&self, f: F) -> Self 
    where F: Fn(f32) -> f32 + Sync + Send {
        match &self.storage {
            Storage::Cpu(data) => data.mapv(f).into(),
            #[cfg(feature = "cuda")]
            _ => panic!("mapv not implemented for non-CPU tensors"),
        }
    }
}
