use super::{Storage, Tensor};
use crate::GPResult;

impl Tensor {
    pub fn try_add(&self, rhs: &Self) -> GPResult<Self> {
        match (&self.storage, &rhs.storage) {
            (Storage::Cpu(a), Storage::Cpu(b)) => Ok((a + b).into()),
            #[cfg(feature = "cuda")]
            _ => self.to_host()?.try_add(&rhs.to_host()?),
        }
    }

    pub fn try_sub(&self, rhs: &Self) -> GPResult<Self> {
        match (&self.storage, &rhs.storage) {
            (Storage::Cpu(a), Storage::Cpu(b)) => Ok((a - b).into()),
            #[cfg(feature = "cuda")]
            _ => self.to_host()?.try_sub(&rhs.to_host()?),
        }
    }

    pub fn try_scalar_sub(lhs: f32, rhs: &Self) -> GPResult<Self> {
        match &rhs.storage {
            Storage::Cpu(a) => Ok((lhs - a).into()),
            #[cfg(feature = "cuda")]
            _ => Self::try_scalar_sub(lhs, &rhs.to_host()?),
        }
    }

    pub fn try_mul(&self, rhs: &Self) -> GPResult<Self> {
        match (&self.storage, &rhs.storage) {
            (Storage::Cpu(a), Storage::Cpu(b)) => Ok((a * b).into()),
            #[cfg(feature = "cuda")]
            _ => self.to_host()?.try_mul(&rhs.to_host()?),
        }
    }

    pub fn try_mul_scalar(&self, rhs: f32) -> GPResult<Self> {
        match &self.storage {
            Storage::Cpu(a) => Ok((a * rhs).into()),
            #[cfg(feature = "cuda")]
            _ => self.to_host()?.try_mul_scalar(rhs),
        }
    }

    pub fn try_div_scalar(&self, rhs: f32) -> GPResult<Self> {
        match &self.storage {
            Storage::Cpu(a) => Ok((a / rhs).into()),
            #[cfg(feature = "cuda")]
            _ => self.to_host()?.try_div_scalar(rhs),
        }
    }

    pub fn try_mapv<F>(&self, f: F) -> GPResult<Self>
    where
        F: Fn(f32) -> f32 + Sync + Send,
    {
        match &self.storage {
            Storage::Cpu(data) => Ok(data.mapv(f).into()),
            #[cfg(feature = "cuda")]
            _ => self.to_host()?.try_mapv(f),
        }
    }

    pub fn try_tensor_eq(&self, other: &Self) -> GPResult<bool> {
        match (&self.storage, &other.storage) {
            (Storage::Cpu(a), Storage::Cpu(b)) => Ok(a == b),
            #[cfg(feature = "cuda")]
            _ => self.to_host()?.try_tensor_eq(&other.to_host()?),
        }
    }
}

// Operator overloads are convenience APIs. CPU tensors execute directly; CUDA
// tensors are copied back to host because Rust operator traits cannot return
// `GPResult`. Use Backend methods for fallible accelerator execution.
impl std::ops::Add for &Tensor {
    type Output = Tensor;
    fn add(self, rhs: Self) -> Self::Output {
        self.try_add(rhs)
            .expect("Tensor add operator failed; use Tensor::try_add for fallible execution")
    }
}

impl std::ops::Sub for &Tensor {
    type Output = Tensor;
    fn sub(self, rhs: Self) -> Self::Output {
        self.try_sub(rhs)
            .expect("Tensor sub operator failed; use Tensor::try_sub for fallible execution")
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
        Tensor::try_scalar_sub(self, rhs).expect(
            "Tensor scalar-sub operator failed; use Tensor::try_scalar_sub for fallible execution",
        )
    }
}

impl std::ops::Mul<f32> for &Tensor {
    type Output = Tensor;
    fn mul(self, rhs: f32) -> Self::Output {
        self.try_mul_scalar(rhs).expect(
            "Tensor scalar-mul operator failed; use Tensor::try_mul_scalar for fallible execution",
        )
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
        self.try_mul(rhs)
            .expect("Tensor mul operator failed; use Tensor::try_mul for fallible execution")
    }
}

impl std::ops::Div<f32> for &Tensor {
    type Output = Tensor;
    fn div(self, rhs: f32) -> Self::Output {
        self.try_div_scalar(rhs).expect(
            "Tensor scalar-div operator failed; use Tensor::try_div_scalar for fallible execution",
        )
    }
}

impl std::ops::SubAssign<&Tensor> for Tensor {
    fn sub_assign(&mut self, rhs: &Tensor) {
        *self = self
            .try_sub(rhs)
            .expect("Tensor sub_assign failed; use Tensor::try_sub for fallible execution");
    }
}

impl std::ops::AddAssign<&Tensor> for Tensor {
    fn add_assign(&mut self, rhs: &Tensor) {
        *self = self
            .try_add(rhs)
            .expect("Tensor add_assign failed; use Tensor::try_add for fallible execution");
    }
}

impl PartialEq for Tensor {
    fn eq(&self, other: &Self) -> bool {
        self.try_tensor_eq(other).unwrap_or(false)
    }
}

impl Tensor {
    pub fn mapv<F>(&self, f: F) -> Self
    where
        F: Fn(f32) -> f32 + Sync + Send,
    {
        self.try_mapv(f)
            .expect("Tensor mapv failed; use Tensor::try_mapv for fallible execution")
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
