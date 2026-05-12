use super::{Storage, Tensor};

#[cfg(feature = "cuda")]
fn host_or_nan(tensor: &Tensor) -> Tensor {
    tensor
        .to_host()
        .unwrap_or_else(|_| Tensor::from_elem(tensor.shape(), f32::NAN))
}

// Operator overloads are convenience APIs. CPU tensors execute directly; CUDA
// tensors are copied back to host because Rust operator traits cannot return
// `GPResult`. Use Backend methods for fallible accelerator execution.
impl std::ops::Add for &Tensor {
    type Output = Tensor;
    fn add(self, rhs: Self) -> Self::Output {
        match (&self.storage, &rhs.storage) {
            (Storage::Cpu(a), Storage::Cpu(b)) => (a + b).into(),
            #[cfg(feature = "cuda")]
            _ => {
                let lhs = host_or_nan(self);
                let rhs = host_or_nan(rhs);
                &lhs + &rhs
            }
        }
    }
}

impl std::ops::Sub for &Tensor {
    type Output = Tensor;
    fn sub(self, rhs: Self) -> Self::Output {
        match (&self.storage, &rhs.storage) {
            (Storage::Cpu(a), Storage::Cpu(b)) => (a - b).into(),
            #[cfg(feature = "cuda")]
            _ => {
                let lhs = host_or_nan(self);
                let rhs = host_or_nan(rhs);
                &lhs - &rhs
            }
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
            Storage::Cpu(a) => (self - a).into(),
            #[cfg(feature = "cuda")]
            _ => {
                let rhs = host_or_nan(rhs);
                self - &rhs
            }
        }
    }
}

impl std::ops::Mul<f32> for &Tensor {
    type Output = Tensor;
    fn mul(self, rhs: f32) -> Self::Output {
        match &self.storage {
            Storage::Cpu(a) => (a * rhs).into(),
            #[cfg(feature = "cuda")]
            _ => {
                let lhs = host_or_nan(self);
                &lhs * rhs
            }
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
            _ => {
                let lhs = host_or_nan(self);
                let rhs = host_or_nan(rhs);
                &lhs * &rhs
            }
        }
    }
}

impl std::ops::Div<f32> for &Tensor {
    type Output = Tensor;
    fn div(self, rhs: f32) -> Self::Output {
        match &self.storage {
            Storage::Cpu(a) => (a / rhs).into(),
            #[cfg(feature = "cuda")]
            _ => {
                let lhs = host_or_nan(self);
                &lhs / rhs
            }
        }
    }
}

impl std::ops::SubAssign<&Tensor> for Tensor {
    fn sub_assign(&mut self, rhs: &Tensor) {
        match (&mut self.storage, &rhs.storage) {
            (Storage::Cpu(a), Storage::Cpu(b)) => *a -= b,
            #[cfg(feature = "cuda")]
            _ => {
                let lhs = host_or_nan(self);
                let rhs = host_or_nan(rhs);
                *self = &lhs - &rhs;
            }
        }
    }
}

impl std::ops::AddAssign<&Tensor> for Tensor {
    fn add_assign(&mut self, rhs: &Tensor) {
        match (&mut self.storage, &rhs.storage) {
            (Storage::Cpu(a), Storage::Cpu(b)) => *a += b,
            #[cfg(feature = "cuda")]
            _ => {
                let lhs = host_or_nan(self);
                let rhs = host_or_nan(rhs);
                *self = &lhs + &rhs;
            }
        }
    }
}

impl PartialEq for Tensor {
    fn eq(&self, other: &Self) -> bool {
        match (&self.storage, &other.storage) {
            (Storage::Cpu(a), Storage::Cpu(b)) => a == b,
            #[cfg(feature = "cuda")]
            _ => {
                let lhs = host_or_nan(self);
                let rhs = host_or_nan(other);
                lhs == rhs
            }
        }
    }
}

impl Tensor {
    pub fn mapv<F>(&self, f: F) -> Self
    where
        F: Fn(f32) -> f32 + Sync + Send,
    {
        match &self.storage {
            Storage::Cpu(data) => data.mapv(f).into(),
            #[cfg(feature = "cuda")]
            _ => {
                let host = host_or_nan(self);
                host.mapv(f)
            }
        }
    }
}

// Implement T + &T
impl std::ops::Add<&Tensor> for Tensor {
    type Output = Tensor;
    fn add(self, rhs: &Tensor) -> Self::Output {
        &self + rhs
    }
}

// Implement T - &T
impl std::ops::Sub<&Tensor> for Tensor {
    type Output = Tensor;
    fn sub(self, rhs: &Tensor) -> Self::Output {
        &self - rhs
    }
}

// Implement T * &T
impl std::ops::Mul<&Tensor> for Tensor {
    type Output = Tensor;
    fn mul(self, rhs: &Tensor) -> Self::Output {
        &self * rhs
    }
}
