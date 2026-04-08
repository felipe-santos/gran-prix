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
        if self.shape() != other.shape() {
            return Err(GPError::IncompatibleShapes { 
                expected: self.shape().to_vec(), 
                found: other.shape().to_vec(),
                exp_len: self.len(),
                found_len: other.len(),
            });
        }
        let mut dest = self.try_view_mut()?;
        let src = other.try_view()?;
        dest.assign(&src);
        Ok(())
    }

    /// Creates a tensor from a raw ndarray. Crate-internal — external code
    /// should use `from_shape_vec()`, `new_zeros()`, `from_elem()`, etc.
    pub(crate) fn new_cpu(data: ArrayD<f32>) -> Self {
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

    /// Returns the underlying ndarray. Crate-internal — external code should use `as_slice()`.
    pub(crate) fn as_cpu(&self) -> GPResult<&ArrayD<f32>> {
        match &self.storage {
            Storage::Cpu(data) => Ok(data),
            #[cfg(feature = "cuda")]
            Storage::Cuda(_) => Err(GPError::DeviceMismatch { 
                required: "CPU".to_string(), 
                actual: "CUDA".to_string() 
            }),
        }
    }

    pub(crate) fn as_cpu_mut(&mut self) -> GPResult<&mut ArrayD<f32>> {
        match &mut self.storage {
            Storage::Cpu(data) => Ok(data),
            #[cfg(feature = "cuda")]
            Storage::Cuda(_) => Err(GPError::DeviceMismatch { 
                required: "CPU".to_string(), 
                actual: "CUDA".to_string() 
            }),
        }
    }

    /// Returns an ndarray view. Crate-internal — external code should use `as_slice()`.
    pub(crate) fn view(&self) -> ArrayViewD<'_, f32> {
        self.try_view().unwrap_or_else(|e| panic!("PRIX ERROR: Failed to get view: {}", e))
    }

    pub(crate) fn try_view(&self) -> GPResult<ArrayViewD<'_, f32>> {
        self.as_cpu().map(|a| a.view())
    }

    pub(crate) fn try_view_mut(&mut self) -> GPResult<ndarray::ArrayViewMutD<'_, f32>> {
        self.as_cpu_mut().map(|a| a.view_mut())
    }

    pub(crate) fn view_mut(&mut self) -> ndarray::ArrayViewMutD<'_, f32> {
        self.try_view_mut().unwrap_or_else(|e| panic!("PRIX ERROR: Failed to get view_mut: {}", e))
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
                        found: self.shape.as_slice().to_vec(),
                        exp_len: shape.iter().product(),
                        found_len: self.shape.size(),
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
                        found: self.shape.as_slice().to_vec(),
                        exp_len: new_size,
                        found_len: old_size,
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
    
    /// Returns an ndarray iterator. Crate-internal — external code should use `as_slice()`.
    pub(crate) fn iter(&self) -> ndarray::iter::Iter<'_, f32, IxDyn> {
        self.as_cpu().map(|a| a.iter()).unwrap_or_else(|_| panic!("iter() only supported on CPU tensors"))
    }
    /// Returns a mutable ndarray iterator. Crate-internal.
    pub(crate) fn iter_mut(&mut self) -> ndarray::iter::IterMut<'_, f32, IxDyn> {
        self.as_cpu_mut().map(|a| a.iter_mut()).unwrap_or_else(|_| panic!("iter_mut() only supported on CPU tensors"))
    }
}

// Crate-internal: allows backend code to convert ndarray → Tensor directly.
impl From<ArrayD<f32>> for Tensor {
    fn from(data: ArrayD<f32>) -> Self {
        Self::new_cpu(data)
    }
}

pub mod ops;

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

    // ── Backend-agnostic constructors ──────────────────────────────────────
    //
    // These replace direct ndarray usage in layers, optimizers, and WASM code.

    /// Creates a tensor filled with a constant value.
    ///
    /// ```rust
    /// # use gran_prix::Tensor;
    /// let t = Tensor::from_elem(&[2, 3], 1.0);
    /// assert_eq!(t.shape(), &[2, 3]);
    /// assert_eq!(t.as_slice().unwrap(), &[1.0; 6]);
    /// ```
    pub fn from_elem(dims: &[usize], value: f32) -> Self {
        Self::new_cpu(ArrayD::from_elem(IxDyn(dims), value))
    }

    /// Creates a tensor filled with ones.
    pub fn new_ones(dims: &[usize]) -> Self {
        Self::from_elem(dims, 1.0)
    }

    /// Creates a tensor from a shape and flat data vector.
    ///
    /// Returns an error if `data.len()` doesn't match the product of `dims`.
    pub fn from_shape_vec(dims: &[usize], data: Vec<f32>) -> GPResult<Self> {
        let array = ArrayD::from_shape_vec(IxDyn(dims), data)
            .map_err(|e| GPError::TensorError(format!(
                "Shape/data mismatch: {}", e
            )))?;
        Ok(Self::new_cpu(array))
    }

    // ── In-place operations (backend-agnostic) ─────────────────────────────

    /// Applies a function to every element in-place.
    ///
    /// Replaces direct `as_cpu_mut().unwrap().map_inplace(f)` calls.
    pub fn map_inplace<F: FnMut(&mut f32)>(&mut self, mut f: F) -> GPResult<()> {
        let slice = self.as_slice_mut()?;
        for v in slice.iter_mut() {
            f(v);
        }
        Ok(())
    }

    /// Scales all elements by a constant factor in-place.
    pub fn scale_inplace(&mut self, factor: f32) -> GPResult<()> {
        self.map_inplace(|v| *v *= factor)
    }

    // ── Indexed access (backend-agnostic) ──────────────────────────────────

    /// Gets a mutable reference to an element at the given flat index.
    pub fn get_flat_mut(&mut self, index: usize) -> GPResult<&mut f32> {
        let len = self.len();
        let slice = self.as_slice_mut()?;
        slice.get_mut(index)
            .ok_or_else(|| GPError::TensorError(format!(
                "Index {} out of bounds (tensor has {} elements)", index, len
            )))
    }

    /// Gets a reference to an element at the given flat index.
    pub fn get_flat(&self, index: usize) -> GPResult<f32> {
        let slice = self.as_slice()?;
        slice.get(index)
            .copied()
            .ok_or_else(|| GPError::TensorError(format!(
                "Index {} out of bounds (tensor has {} elements)", index, slice.len()
            )))
    }

    /// Gets the value at a 2D index [row, col].
    ///
    /// Assumes row-major layout.
    pub fn get_2d(&self, row: usize, col: usize) -> GPResult<f32> {
        let shape = self.shape().to_vec();
        if shape.len() < 2 || row >= shape[0] || col >= shape[1] {
            return Err(GPError::TensorError(format!(
                "2D index [{}, {}] out of bounds for shape {:?}", row, col, shape
            )));
        }
        let flat_idx = row * shape[1] + col;
        self.get_flat(flat_idx)
    }

    /// Gets a mutable reference to an element at a 2D index [row, col].
    ///
    /// Assumes row-major layout. Returns error if out of bounds.
    pub fn get_2d_mut(&mut self, row: usize, col: usize) -> GPResult<&mut f32> {
        let shape = self.shape().to_vec();
        if shape.len() < 2 || row >= shape[0] || col >= shape[1] {
            return Err(GPError::TensorError(format!(
                "2D index [{}, {}] out of bounds for shape {:?}", row, col, shape
            )));
        }
        let flat_idx = row * shape[1] + col;
        self.get_flat_mut(flat_idx)
    }

    /// Copies this tensor's data into a new `Vec<f32>`.
    pub fn to_vec(&self) -> GPResult<Vec<f32>> {
        self.as_slice().map(|s| s.to_vec())
    }
}
