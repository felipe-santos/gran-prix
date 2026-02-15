use ndarray::{ArrayD, IxDyn, ArrayViewD, Dimension};
use serde::{Serialize, Deserialize, Serializer, Deserializer};

#[derive(Clone, Debug)]
pub enum Storage {
    Cpu(ArrayD<f32>),
    #[cfg(feature = "cuda")]
    Cuda(Arc<cudarc::driver::CudaSlice<f32>>),
}

// Manual Serialize/Deserialize for Storage because CudaSlice doesn't support it.
// We always save/load from CPU for persistence.
impl Serialize for Storage {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where S: Serializer {
        match self {
            Storage::Cpu(data) => data.serialize(serializer),
            #[cfg(feature = "cuda")]
            Storage::Cuda(slice) => {
                // For serialization, we must move to host
                let data = slice.device().dtoh_sync_copy(slice.as_ref())
                    .map_err(serde::ser::Error::custom)?;
                serializer.serialize_newtype_variant("Storage", 0, "Cpu", &data)
            }
        }
    }
}

impl<'de> Deserialize<'de> for Storage {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where D: Deserializer<'de> {
        let data = ArrayD::<f32>::deserialize(deserializer)?;
        Ok(Storage::Cpu(data))
    }
}

/// An N-Dimensional Tensor abstraction supporting multiple backends.
/// Encapsulates storage (CPU/GPU) and shape information.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tensor {
    storage: Storage,
    shape: IxDyn,
}

impl Tensor {
    pub fn new_cpu(data: ArrayD<f32>) -> Self {
        let shape = data.raw_dim();
        Self {
            storage: Storage::Cpu(data),
            shape,
        }
    }

    pub fn shape(&self) -> &[usize] {
        self.shape.slice()
    }

    pub fn ndim(&self) -> usize {
        self.shape.ndim()
    }

    /// Returns a view of the tensor as an ndarray ArrayViewD if it's on the CPU.
    /// Returns None if the tensor is on another device.
    pub fn as_cpu(&self) -> Option<&ArrayD<f32>> {
        match &self.storage {
            Storage::Cpu(data) => Some(data),
            #[cfg(feature = "cuda")]
            _ => None,
        }
    }

    pub fn as_cpu_mut(&mut self) -> Option<&mut ArrayD<f32>> {
        match &mut self.storage {
            Storage::Cpu(data) => Some(data),
            #[cfg(feature = "cuda")]
            _ => None,
        }
    }

    /// Helper to get ndarray view, with expectation it is on CPU.
    pub fn view(&self) -> ArrayViewD<'_, f32> {
        self.as_cpu().expect("Attempted to view a non-CPU tensor as ndarray. Move to CPU first.").view()
    }

    pub fn view_mut(&mut self) -> ndarray::ArrayViewMutD<'_, f32> {
        self.as_cpu_mut().expect("Attempted to view_mut a non-CPU tensor as ndarray. Move to CPU first.").view_mut()
    }

    #[cfg(feature = "cuda")]
    pub fn to_cuda(&self, device: &Arc<cudarc::driver::CudaDevice>) -> anyhow::Result<Self> {
        match &self.storage {
            Storage::Cpu(data) => {
                let slice = device.htod_copy(data.as_slice().ok_or_else(|| anyhow::anyhow!("Non-contiguous CPU tensor"))?.to_vec())
                    .map_err(|e| anyhow::anyhow!("CUDA HtoD copy failed: {:?}", e))?;
                Ok(Self {
                    storage: Storage::Cuda(Arc::new(slice)),
                    shape: self.shape.clone(),
                })
            }
            Storage::Cuda(_) => Ok(self.clone()),
        }
    }

    pub fn to_host(&self) -> anyhow::Result<Self> {
        match &self.storage {
            Storage::Cpu(_) => Ok(self.clone()),
            #[cfg(feature = "cuda")]
            Storage::Cuda(slice) => {
                let data = slice.device().dtoh_sync_copy(slice.as_ref())
                    .map_err(|e| anyhow::anyhow!("CUDA DtoH copy failed: {:?}", e))?;
                let array = ArrayD::from_shape_vec(self.shape.clone(), data)?;
                Ok(Self::new_cpu(array))
            }
        }
    }

    pub fn storage(&self) -> &Storage {
        &self.storage
    }

    #[cfg(feature = "cuda")]
    pub fn new_cuda(slice: Arc<cudarc::driver::CudaSlice<f32>>, shape: Vec<usize>) -> Self {
        Self {
            storage: Storage::Cuda(slice),
            shape: IxDyn(&shape),
        }
    }

    pub fn into_shape(self, shape: &[usize]) -> anyhow::Result<Self> {
        match self.storage {
            Storage::Cpu(data) => {
                Ok(Self::new_cpu(data.into_shape(IxDyn(shape))?))
            }
            #[cfg(feature = "cuda")]
            Storage::Cuda(slice) => {
                let new_size: usize = shape.iter().product();
                let old_size: usize = self.shape.slice().iter().product();
                if new_size != old_size {
                    return Err(anyhow::anyhow!("Reshape mismatch: {} vs {}", old_size, new_size));
                }
                Ok(Self {
                    storage: Storage::Cuda(slice),
                    shape: IxDyn(shape),
                })
            }
        }
    }

    pub fn into_dyn(self) -> Self {
        self
    }
}

// Implement basic traits for ease of transition
impl From<ArrayD<f32>> for Tensor {
    fn from(data: ArrayD<f32>) -> Self {
        Self::new_cpu(data)
    }
}

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
            Storage::Cpu(a) => (self - a).into(),
            #[cfg(feature = "cuda")]
            _ => panic!("Scalar subtraction on non-CPU tensors not yet implemented."),
        }
    }
}

impl std::ops::Mul<f32> for &Tensor {
    type Output = Tensor;
    fn mul(self, rhs: f32) -> Self::Output {
        match &self.storage {
            Storage::Cpu(a) => (a * rhs).into(),
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
            Storage::Cpu(a) => (a / rhs).into(),
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

// Support for .iter() and deref-like access for CPU
impl Tensor {
    pub fn iter(&self) -> ndarray::iter::Iter<'_, f32, IxDyn> {
        self.as_cpu().expect("iter() only supported on CPU tensors").iter()
    }
    pub fn iter_mut(&mut self) -> ndarray::iter::IterMut<'_, f32, IxDyn> {
        self.as_cpu_mut().expect("iter_mut() only supported on CPU tensors").iter_mut()
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

impl Tensor {
    pub fn mean(&self) -> Option<f32> {
        match &self.storage {
            Storage::Cpu(data) => data.mean(),
            #[cfg(feature = "cuda")]
            _ => panic!("mean() not implemented for non-CPU tensors"),
        }
    }

    pub fn len(&self) -> usize {
        match &self.storage {
            Storage::Cpu(data) => data.len(),
            #[cfg(feature = "cuda")]
            Storage::Cuda(_) => self.shape.slice().iter().product(),
        }
    }
}
