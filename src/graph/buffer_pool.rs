use crate::Tensor;

/// A pool of pre-allocated buffers for zero-allocation execution.
pub struct BufferPool {
    /// Maps buffer index to the actual Tensor
    buffers: Vec<Option<Tensor>>,
}

impl BufferPool {
    pub fn new(count: usize) -> Self {
        Self {
            buffers: vec![None; count],
        }
    }

    /// Allocates or reuses a buffer for a specific operation.
    pub fn get_buffer(&mut self, idx: usize, shape: &[usize]) -> Tensor {
        if let Some(existing) = &self.buffers[idx] {
            if existing.shape() == shape {
                return existing.clone();
            }
        }
        
        // Dynamic allocation (fallback or first-time)
        let new_tensor = Tensor::zeros(shape);
        self.buffers[idx] = Some(new_tensor.clone());
        new_tensor
    }
}
