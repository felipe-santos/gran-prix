#[cfg(feature = "cuda")]
use cudarc::driver::{CudaDevice, LaunchConfig, LaunchAsync};
#[cfg(feature = "cuda")]
use std::sync::Arc;
#[cfg(feature = "cuda")]
use crate::{Tensor, GPResult, GPError};
#[cfg(feature = "cuda")]
use crate::backend::Backend;

#[cfg(feature = "cuda")]
mod kernels;

#[cfg(feature = "cuda")]
#[derive(Debug)]
pub struct CUDABackend {
    device: Arc<CudaDevice>,
    blas: Arc<cudarc::cublas::Cudablas>,
}

#[cfg(feature = "cuda")]
impl CUDABackend {
    pub fn new(device_index: usize) -> GPResult<Self> {
        let device = CudaDevice::new(device_index)
            .map_err(|e| GPError::BackendError(format!("Failed to initialize CUDA device {}: {:?}", device_index, e)))?;
        
        let blas = Arc::new(cudarc::cublas::Cudablas::new(device.clone())
            .map_err(|e| GPError::BackendError(format!("Failed to initialize cuBLAS: {:?}", e)))?);
        
        // Compile and load kernels
        let ptx = cudarc::nvrtc::compile_ptx(kernels::ELEMENTWISE_KERNELS)
            .map_err(|e| GPError::BackendError(format!("NVRTC compilation failed: {:?}", e)))?;
        device.load_ptx(ptx, "elementwise", &[
            "relu_kernel", "sigmoid_kernel", "add_kernel", 
            "conv2d_kernel", "max_pool2d_kernel",
            "relu_backward_kernel", "sigmoid_backward_kernel",
            "sgd_update_kernel",
            "conv2d_grad_input_kernel", "conv2d_grad_weight_kernel",
            "max_pool2d_backward_kernel"
        ])
            .map_err(|e| GPError::BackendError(format!("Failed to load PTX: {:?}", e)))?;

        Ok(Self { device, blas })
    }

    pub fn device(&self) -> &Arc<CudaDevice> {
        &self.device
    }

    fn get_cuda_slice<'a>(&self, t: &'a Tensor) -> GPResult<Arc<cudarc::driver::CudaSlice<f32>>> {
        match t.storage() {
            crate::tensor::Storage::Cuda(slice) => Ok(slice.clone()),
            crate::tensor::Storage::Cpu(_) => {
                // Auto-upload if on CPU
                let t_cuda = t.to_cuda(&self.device)?;
                if let crate::tensor::Storage::Cuda(slice) = t_cuda.storage() {
                    Ok(slice.clone())
                } else {
                    Err(GPError::TensorError("Failed to auto-upload tensor to CUDA".to_string()))
                }
            }
        }
    }
}

#[cfg(feature = "cuda")]
impl Backend for CUDABackend {
    fn relu(&self, x: &Tensor) -> GPResult<Tensor> {
        let in_slice = self.get_cuda_slice(x)?;
        let n = x.len();
        let mut out_slice = self.device.alloc_zeros::<f32>(n)
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;
        
        let func = self.device.get_func("elementwise", "relu_kernel")
            .ok_or_else(|| GPError::BackendError("Kernel 'relu_kernel' not found".to_string()))?;
        
        let cfg = LaunchConfig::for_num_elems(n as u32);
        unsafe { func.launch(cfg, (&mut out_slice, in_slice.as_ref(), n as i32)) }
            .map_err(|e| GPError::BackendError(format!("Kernel launch failed: {:?}", e)))?;
        
        Ok(Tensor::new_cuda(Arc::new(out_slice), x.shape().to_vec()))
    }

    fn sigmoid(&self, x: &Tensor) -> GPResult<Tensor> {
        let in_slice = self.get_cuda_slice(x)?;
        let n = x.len();
        let mut out_slice = self.device.alloc_zeros::<f32>(n)
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;
        
        let func = self.device.get_func("elementwise", "sigmoid_kernel")
            .ok_or_else(|| GPError::BackendError("Kernel 'sigmoid_kernel' not found".to_string()))?;
        
        let cfg = LaunchConfig::for_num_elems(n as u32);
        unsafe { func.launch(cfg, (&mut out_slice, in_slice.as_ref(), n as i32)) }
            .map_err(|e| GPError::BackendError(format!("Kernel launch failed: {:?}", e)))?;
        
        Ok(Tensor::new_cuda(Arc::new(out_slice), x.shape().to_vec()))
    }

    fn add(&self, a: &Tensor, b: &Tensor) -> GPResult<Tensor> {
        let a_slice = self.get_cuda_slice(a)?;
        let b_slice = self.get_cuda_slice(b)?;
        let n = a.len();
        let mut out_slice = self.device.alloc_zeros::<f32>(n)
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;
        
        let func = self.device.get_func("elementwise", "add_kernel")
            .ok_or_else(|| GPError::BackendError("Kernel 'add_kernel' not found".to_string()))?;
        
        let cfg = LaunchConfig::for_num_elems(n as u32);
        unsafe { func.launch(cfg, (&mut out_slice, a_slice.as_ref(), b_slice.as_ref(), n as i32)) }
            .map_err(|e| GPError::BackendError(format!("Kernel launch failed: {:?}", e)))?;
        
        Ok(Tensor::new_cuda(Arc::new(out_slice), a.shape().to_vec()))
    }

    fn matmul_t(&self, a: &Tensor, b: &Tensor, trans_a: bool, trans_b: bool) -> GPResult<Tensor> {
        let a_slice = self.get_cuda_slice(a)?;
        let b_slice = self.get_cuda_slice(b)?;
        
        // ndarray shapes are (rows, cols)
        let a_shape = a.shape();
        let b_shape = b.shape();
        
        let (m, k) = if trans_a { (a_shape[1], a_shape[0]) } else { (a_shape[0], a_shape[1]) };
        let (k_b, n) = if trans_b { (b_shape[1], b_shape[0]) } else { (b_shape[0], b_shape[1]) };
        
        if k != k_b {
            return Err(GPError::IncompatibleShapes { 
                expected: vec![m, k_b], 
                found: vec![m, k],
                exp_len: m * k_b,
                found_len: m * k,
            });
        }

        let mut out_slice = self.device.alloc_zeros::<f32>(m * n)
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;

        use cudarc::cublas::sys::cublasOperation_t;
        let op_a = if trans_a { cublasOperation_t::CUBLAS_OP_T } else { cublasOperation_t::CUBLAS_OP_N };
        let op_b = if trans_b { cublasOperation_t::CUBLAS_OP_T } else { cublasOperation_t::CUBLAS_OP_N };

        // cuBLAS is column-major, but our tensors are row-major.
        // C = A * B in row-major is equivalent to C^T = B^T * A^T in column-major.
        // Wait, cudarc's sgemm helper might handle some of this.
        // Let's use the high-level sgemm if available.
        
        use cudarc::cublas::Gemm;
        // In row-major: C = op(A) * op(B)
        // With m, n, k as defined for row-major.
        // We can pass op_b, op_a to sgemm with swapped order to get row-major C.
        // Actually, let's keep it simple: assume B is already the right shape.
        
        unsafe {
            self.blas.sgemm(
                op_b,
                op_a,
                n as i32,
                m as i32,
                k as i32,
                &1.0,
                b_slice.as_ref(),
                if trans_b { k as i32 } else { n as i32 },
                a_slice.as_ref(),
                if trans_a { m as i32 } else { k as i32 },
                &0.0,
                &mut out_slice,
                n as i32,
            ).map_err(|e| GPError::BackendError(format!("cuBLAS sgemm failed: {:?}", e)))?;
        }

        Ok(Tensor::new_cuda(Arc::new(out_slice), vec![m, n]))
    }

    fn conv2d(&self, input: &Tensor, weight: &Tensor, stride: usize, padding: usize) -> GPResult<Tensor> {
        let in_slice = self.get_cuda_slice(input)?;
        let w_slice = self.get_cuda_slice(weight)?;
        
        let in_shape = input.shape();
        let w_shape = weight.shape();
        
        let (n, ci, h, w) = (in_shape[0], in_shape[1], in_shape[2], in_shape[3]);
        let (co, _ci, kh, kw) = (w_shape[0], w_shape[1], w_shape[2], w_shape[3]);
        
        let oh = (h + 2 * padding - kh) / stride + 1;
        let ow = (w + 2 * padding - kw) / stride + 1;
        
        let mut out_slice = self.device.alloc_zeros::<f32>(n * co * oh * ow)
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;
        
        let func = self.device.get_func("elementwise", "conv2d_kernel")
            .ok_or_else(|| GPError::BackendError("Kernel 'conv2d_kernel' not found".to_string()))?;
        
        let total_threads = (n * co * oh * ow) as u32;
        let cfg = LaunchConfig::for_num_elems(total_threads);
        
        unsafe {
            func.launch(cfg, (
                &mut out_slice, in_slice.as_ref(), w_slice.as_ref(),
                n as i32, ci as i32, h as i32, w as i32,
                co as i32, kh as i32, kw as i32,
                oh as i32, ow as i32,
                stride as i32, padding as i32
            ))
        }.map_err(|e| GPError::BackendError(format!("Kernel launch failed: {:?}", e)))?;
        
        Ok(Tensor::new_cuda(Arc::new(out_slice), vec![n, co, oh, ow]))
    }

    fn conv2d_backward(&self, input: &Tensor, weight: &Tensor, grad_output: &Tensor, stride: usize, padding: usize) -> GPResult<(Tensor, Tensor)> {
        let in_slice = self.get_cuda_slice(input)?;
        let w_slice = self.get_cuda_slice(weight)?;
        let grad_out_slice = self.get_cuda_slice(grad_output)?;
        
        let in_shape = input.shape();
        let w_shape = weight.shape();
        let grad_out_shape = grad_output.shape();
        
        let (n, ci, h, w) = (in_shape[0], in_shape[1], in_shape[2], in_shape[3]);
        let (co, _ci, kh, kw) = (w_shape[0], w_shape[1], w_shape[2], w_shape[3]);
        let (_n, _co, oh, ow) = (grad_out_shape[0], grad_out_shape[1], grad_out_shape[2], grad_out_shape[3]);
        
        // 1. Grad for Input
        let mut grad_in_slice = self.device.alloc_zeros::<f32>(n * ci * h * w)
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;
        let func_in = self.device.get_func("elementwise", "conv2d_grad_input_kernel")
            .ok_or_else(|| GPError::BackendError("Kernel 'conv2d_grad_input_kernel' not found".to_string()))?;
        let cfg_in = LaunchConfig::for_num_elems((n * ci * h * w) as u32);
        unsafe {
            func_in.launch(cfg_in, (
                &mut grad_in_slice, grad_out_slice.as_ref(), w_slice.as_ref(),
                n as i32, ci as i32, h as i32, w as i32,
                co as i32, kh as i32, kw as i32,
                oh as i32, ow as i32,
                stride as i32, padding as i32
            ))
        }.map_err(|e| GPError::BackendError(format!("Kernel launch failed: {:?}", e)))?;

        // 2. Grad for Weight
        let mut grad_w_slice = self.device.alloc_zeros::<f32>(co * ci * kh * kw)
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;
        let func_w = self.device.get_func("elementwise", "conv2d_grad_weight_kernel")
            .ok_or_else(|| GPError::BackendError("Kernel 'conv2d_grad_weight_kernel' not found".to_string()))?;
        let cfg_w = LaunchConfig::for_num_elems((co * ci * kh * kw) as u32);
        unsafe {
            func_w.launch(cfg_w, (
                &mut grad_w_slice, grad_out_slice.as_ref(), in_slice.as_ref(),
                n as i32, ci as i32, h as i32, w as i32,
                co as i32, kh as i32, kw as i32,
                oh as i32, ow as i32,
                stride as i32, padding as i32
            ))
        }.map_err(|e| GPError::BackendError(format!("Kernel launch failed: {:?}", e)))?;
        
        Ok((
            Tensor::new_cuda(Arc::new(grad_in_slice), vec![n, ci, h, w]),
            Tensor::new_cuda(Arc::new(grad_w_slice), vec![co, ci, kh, kw])
        ))
    }

    fn max_pool2d(&self, input: &Tensor, kernel_size: usize, stride: usize) -> GPResult<Tensor> {
        let in_slice = self.get_cuda_slice(input)?;
        let in_shape = input.shape();
        let (n, c, h, w) = (in_shape[0], in_shape[1], in_shape[2], in_shape[3]);
        
        let oh = (h - kernel_size) / stride + 1;
        let ow = (w - kernel_size) / stride + 1;
        
        let mut out_slice = self.device.alloc_zeros::<f32>(n * c * oh * ow)
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;
        
        let func = self.device.get_func("elementwise", "max_pool2d_kernel")
            .ok_or_else(|| GPError::BackendError("Kernel 'max_pool2d_kernel' not found".to_string()))?;
        
        let total_threads = (n * c * oh * ow) as u32;
        let cfg = LaunchConfig::for_num_elems(total_threads);
        
        unsafe {
            func.launch(cfg, (
                &mut out_slice, in_slice.as_ref(),
                n as i32, c as i32, h as i32, w as i32,
                oh as i32, ow as i32,
                kernel_size as i32, kernel_size as i32,
                stride as i32
            ))
        }.map_err(|e| GPError::BackendError(format!("Kernel launch failed: {:?}", e)))?;
        
        Ok(Tensor::new_cuda(Arc::new(out_slice), vec![n, c, oh, ow]))
    }

    fn max_pool2d_backward(&self, input: &Tensor, grad_output: &Tensor, kernel_size: usize, stride: usize) -> GPResult<Tensor> {
        let in_slice = self.get_cuda_slice(input)?;
        let grad_out_slice = self.get_cuda_slice(grad_output)?;
        
        let in_shape = input.shape();
        let grad_out_shape = grad_output.shape();
        
        let (n, c, h, w) = (in_shape[0], in_shape[1], in_shape[2], in_shape[3]);
        let (_n, _c, oh, ow) = (grad_out_shape[0], grad_out_shape[1], grad_out_shape[2], grad_out_shape[3]);
        
        let mut grad_in_slice = self.device.alloc_zeros::<f32>(n * c * h * w)
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;
        
        let func = self.device.get_func("elementwise", "max_pool2d_backward_kernel")
            .ok_or_else(|| GPError::BackendError("Kernel 'max_pool2d_backward_kernel' not found".to_string()))?;
        
        let cfg = LaunchConfig::for_num_elems((n * c * oh * ow) as u32);
        unsafe {
            func.launch(cfg, (
                &mut grad_in_slice, grad_out_slice.as_ref(), in_slice.as_ref(),
                n as i32, c as i32, h as i32, w as i32,
                oh as i32, ow as i32,
                kernel_size as i32, kernel_size as i32,
                stride as i32
            ))
        }.map_err(|e| GPError::BackendError(format!("Kernel launch failed: {:?}", e)))?;
        
        Ok(Tensor::new_cuda(Arc::new(grad_in_slice), vec![n, c, h, w]))
    }

    fn add_relu(&self, a: &Tensor, b: &Tensor) -> GPResult<Tensor> {
        let sum = self.add(a, b)?;
        self.relu(&sum)
    }

    fn update_parameter(&self, param: &mut Tensor, grad: &Tensor, learning_rate: f32) -> GPResult<()> {
        let param_slice = self.get_cuda_slice(param)?;
        let grad_slice = self.get_cuda_slice(grad)?;
        let n = param.len();

        let func = self.device.get_func("elementwise", "sgd_update_kernel")
            .ok_or_else(|| GPError::BackendError("Kernel 'sgd_update_kernel' not found".to_string()))?;
        
        let cfg = LaunchConfig::for_num_elems(n as u32);
        unsafe {
            func.launch(cfg, (param_slice.as_ref(), grad_slice.as_ref(), learning_rate, n as i32))
        }.map_err(|e| GPError::BackendError(format!("Kernel launch failed: {:?}", e)))?;
        
        Ok(())
    }

    fn relu_backward(&self, input: &Tensor, grad_output: &Tensor) -> GPResult<Tensor> {
        let in_slice = self.get_cuda_slice(input)?;
        let grad_out_slice = self.get_cuda_slice(grad_output)?;
        let n = input.len();
        let mut grad_in_slice = self.device.alloc_zeros::<f32>(n)
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;
        
        let func = self.device.get_func("elementwise", "relu_backward_kernel")
            .ok_or_else(|| GPError::BackendError("Kernel 'relu_backward_kernel' not found".to_string()))?;
        
        let cfg = LaunchConfig::for_num_elems(n as u32);
        unsafe {
            func.launch(cfg, (&mut grad_in_slice, in_slice.as_ref(), grad_out_slice.as_ref(), n as i32))
        }.map_err(|e| GPError::BackendError(format!("Kernel launch failed: {:?}", e)))?;
        
        Ok(Tensor::new_cuda(Arc::new(grad_in_slice), input.shape().to_vec()))
    }

    fn sigmoid_backward(&self, output: &Tensor, grad_output: &Tensor) -> GPResult<Tensor> {
        let out_slice = self.get_cuda_slice(output)?;
        let grad_out_slice = self.get_cuda_slice(grad_output)?;
        let n = output.len();
        let mut grad_in_slice = self.device.alloc_zeros::<f32>(n)
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;
        
        let func = self.device.get_func("elementwise", "sigmoid_backward_kernel")
            .ok_or_else(|| GPError::BackendError("Kernel 'sigmoid_backward_kernel' not found".to_string()))?;
        
        let cfg = LaunchConfig::for_num_elems(n as u32);
        unsafe {
            func.launch(cfg, (&mut grad_in_slice, out_slice.as_ref(), grad_out_slice.as_ref(), n as i32))
        }.map_err(|e| GPError::BackendError(format!("Kernel launch failed: {:?}", e)))?;
        
        Ok(Tensor::new_cuda(Arc::new(grad_in_slice), output.shape().to_vec()))
    }
}
