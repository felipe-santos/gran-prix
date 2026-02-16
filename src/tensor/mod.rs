pub mod storage;
pub use storage::Storage;

use ndarray::{ArrayD, IxDyn, ArrayViewD};
use serde::{Serialize, Deserialize};
use crate::{GPError, GPResult, types::Shape, Device};
#[cfg(feature = "cuda")]
use cudarc::driver::{LaunchAsync};

/// An N-Dimensional Tensor abstraction supporting multiple backends.
/// Encapsulates storage (CPU/GPU) and shape information.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tensor {
    pub(crate) storage: Storage,
    pub(crate) shape: Shape,
}

impl Tensor {
    pub fn copy_from(&mut self, other: &Self) -> GPResult<()> {
        let dest = self.as_slice_mut()?;
        let src = other.as_slice()?;
        if dest.len() != src.len() {
            return Err(GPError::IncompatibleShapes { 
                expected: self.shape().to_vec(), 
                found: other.shape().to_vec() 
            });
        }
        dest.copy_from_slice(src);
        Ok(())
    }

    pub fn new_cpu(data: ArrayD<f32>) -> Self {
        let shape = Shape(data.raw_dim());
        Self {
            storage: Storage::Cpu(data),
            shape,
        }
    }

    pub fn new_zeros(dims: &[usize]) -> Self {
        Self::new_cpu(ArrayD::zeros(ndarray::IxDyn(dims)))
    }

    pub fn new_random(dims: &[usize]) -> Self {
        use ndarray_rand::RandomExt;
        use rand::distributions::Uniform;
        Self::new_cpu(ArrayD::random(ndarray::IxDyn(dims), Uniform::new(-1.0, 1.0)))
    }

    pub fn shape(&self) -> &[usize] {
        self.shape.as_slice()
    }

    pub fn ndim(&self) -> usize {
        self.shape.ndim()
    }

    /// Returns a view of the tensor as an ndarray ArrayViewD if it's on the CPU.
    pub fn as_cpu(&self) -> GPResult<&ArrayD<f32>> {
        match &self.storage {
            Storage::Cpu(data) => Ok(data),
            #[cfg(feature = "cuda")]
            Storage::Cuda(_) => Err(GPError::DeviceMismatch { 
                required: "CPU".to_string(), 
                actual: "CUDA".to_string() 
            }),
        }
    }

    pub fn as_cpu_mut(&mut self) -> GPResult<&mut ArrayD<f32>> {
        match &mut self.storage {
            Storage::Cpu(data) => Ok(data),
            #[cfg(feature = "cuda")]
            Storage::Cuda(_) => Err(GPError::DeviceMismatch { 
                required: "CPU".to_string(), 
                actual: "CUDA".to_string() 
            }),
        }
    }

    /// Helper to get ndarray view, with expectation it is on CPU.
    pub fn view(&self) -> ArrayViewD<'_, f32> {
        self.as_cpu().expect("Attempted to view a non-CPU tensor. Move to CPU first.").view()
    }

    pub fn try_view(&self) -> GPResult<ArrayViewD<'_, f32>> {
        self.as_cpu().map(|a| a.view())
    }

    pub fn try_view_mut(&mut self) -> GPResult<ndarray::ArrayViewMutD<'_, f32>> {
        self.as_cpu_mut().map(|a| a.view_mut())
    }

    pub fn view_mut(&mut self) -> ndarray::ArrayViewMutD<'_, f32> {
        self.as_cpu_mut().expect("Attempted to view_mut a non-CPU tensor. Move to CPU first.").view_mut()
    }

    #[cfg(feature = "cuda")]
    pub fn to_cuda(&self, device: &Arc<cudarc::driver::CudaDevice>) -> GPResult<Self> {
        match &self.storage {
            Storage::Cpu(data) => {
                let slice = device.htod_copy(data.as_slice().ok_or_else(|| GPError::TensorError("Non-contiguous CPU tensor".to_string()))?.to_vec())
                    .map_err(|e| GPError::BackendError(format!("CUDA HtoD copy failed: {:?}", e)))?;
                Ok(Self {
                    storage: Storage::Cuda(Arc::new(slice)),
                    shape: self.shape.clone(),
                })
            }
            Storage::Cuda(_) => Ok(self.clone()),
        }
    }

    pub fn to_host(&self) -> GPResult<Self> {
        match &self.storage {
            Storage::Cpu(_) => Ok(self.clone()),
            #[cfg(feature = "cuda")]
            Storage::Cuda(slice) => {
                let data = slice.device().dtoh_sync_copy(slice.as_ref())
                    .map_err(|e| GPError::BackendError(format!("CUDA DtoH copy failed: {:?}", e)))?;
                let array = ArrayD::from_shape_vec(self.shape.0.clone(), data)
                    .map_err(|e| GPError::TensorError(format!("Failed to create host array: {:?}", e)))?;
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
            shape: Shape::from_slice(&shape),
        }
    }

    pub fn into_shape(self, shape: &[usize]) -> GPResult<Self> {
        match self.storage {
            Storage::Cpu(data) => {
                let reshaped = data.into_shape(IxDyn(shape))
                    .map_err(|_e| GPError::IncompatibleShapes { 
                        expected: shape.to_vec(), 
                        found: self.shape.as_slice().to_vec() 
                    })?;
                Ok(Self::new_cpu(reshaped))
            }
            #[cfg(feature = "cuda")]
            Storage::Cuda(slice) => {
                let new_size: usize = shape.iter().product();
                let old_size: usize = self.shape.size();
                if new_size != old_size {
                    return Err(GPError::IncompatibleShapes { 
                        expected: shape.to_vec(), 
                        found: self.shape.as_slice().to_vec() 
                    });
                }
                Ok(Self {
                    storage: Storage::Cuda(slice),
                    shape: Shape::from_slice(shape),
                })
            }
        }
    }

    pub fn into_dyn(self) -> Self {
        self
    }
    
    pub fn iter(&self) -> ndarray::iter::Iter<'_, f32, IxDyn> {
        self.as_cpu().expect("iter() only supported on CPU tensors").iter()
    }
    pub fn iter_mut(&mut self) -> ndarray::iter::IterMut<'_, f32, IxDyn> {
        self.as_cpu_mut().expect("iter_mut() only supported on CPU tensors").iter_mut()
    }
}

// Implement basic traits for ease of transition
impl From<ArrayD<f32>> for Tensor {
    fn from(data: ArrayD<f32>) -> Self {
        Self::new_cpu(data)
    }
}

pub mod ops;
pub use ops::TensorOps;

impl Tensor {
    pub fn device(&self) -> Device {
        match &self.storage {
            Storage::Cpu(_) => Device::Cpu,
            #[cfg(feature = "cuda")]
            Storage::Cuda(slice) => Device::Cuda(slice.device().id()),
        }
    }

    pub fn mean(&self) -> GPResult<f32> {
        match &self.storage {
            Storage::Cpu(data) => data.mean().ok_or_else(|| GPError::TensorError("Empty tensor".to_string())),
            #[cfg(feature = "cuda")]
            Storage::Cuda(_) => Err(GPError::NotImplemented("mean() for CUDA".to_string())),
        }
    }

    pub fn len(&self) -> usize {
        self.shape.size()
    }

    pub fn as_slice(&self) -> GPResult<&[f32]> {
        match &self.storage {
            Storage::Cpu(a) => a.as_slice().ok_or_else(|| GPError::TensorError("Failed to get CPU slice".to_string())),
            #[cfg(feature = "cuda")]
            _ => Err(GPError::BackendError("Not a CPU tensor".to_string())),
        }
    }

    pub fn as_slice_mut(&mut self) -> GPResult<&mut [f32]> {
        match &mut self.storage {
            Storage::Cpu(a) => a.as_slice_mut().ok_or_else(|| GPError::TensorError("Failed to get CPU slice mut".to_string())),
            #[cfg(feature = "cuda")]
            _ => Err(GPError::BackendError("Not a CPU tensor".to_string())),
        }
    }
}
