//! CUDA backend — experimental.
//!
//! The feature currently provides CUDA tensor storage and a `Backend`
//! implementation that falls back to the CPU backend after copying tensors to
//! host memory. This keeps the `cuda` feature compileable and panic-free while
//! native kernels/cuBLAS are rebuilt against the current backend trait.

#[cfg(feature = "cuda")]
use std::panic::{catch_unwind, AssertUnwindSafe};
#[cfg(feature = "cuda")]
use std::sync::Arc;

#[cfg(feature = "cuda")]
use crate::backend::{cpu::CPUBackend, Backend};
#[cfg(feature = "cuda")]
use crate::{GPError, GPResult, Tensor};
#[cfg(feature = "cuda")]
use cudarc::driver::{CudaFunction, CudaSlice, LaunchConfig, PushKernelArg};
#[cfg(feature = "cuda")]
use cudarc::nvrtc::compile_ptx;

#[cfg(feature = "cuda")]
mod kernels;

#[cfg(feature = "cuda")]
#[derive(Debug)]
pub struct CUDABackend {
    stream: Arc<cudarc::driver::CudaStream>,
    kernels: CudaKernels,
    cpu: CPUBackend,
}

#[cfg(feature = "cuda")]
#[derive(Debug)]
struct CudaKernels {
    add: CudaFunction,
    mul: CudaFunction,
    relu: CudaFunction,
    sigmoid: CudaFunction,
    tanh: CudaFunction,
    relu_backward: CudaFunction,
    sigmoid_backward: CudaFunction,
    tanh_backward: CudaFunction,
    add_relu: CudaFunction,
    sgd_update: CudaFunction,
    reduce_sum: CudaFunction,
    matmul: CudaFunction,
}

#[cfg(feature = "cuda")]
impl CUDABackend {
    pub fn new(device_index: usize) -> GPResult<Self> {
        let (stream, kernels) = catch_unwind(AssertUnwindSafe(|| -> GPResult<_> {
            let context = cudarc::driver::CudaContext::new(device_index).map_err(|e| {
                GPError::BackendError(format!(
                    "Failed to initialize CUDA context {}: {:?}",
                    device_index, e
                ))
            })?;
            let ptx = compile_ptx(kernels::CUDA_KERNELS).map_err(|e| {
                GPError::BackendError(format!("CUDA kernel compilation failed: {:?}", e))
            })?;
            let module = context
                .load_module(ptx)
                .map_err(|e| GPError::BackendError(format!("CUDA module load failed: {:?}", e)))?;
            let kernels = CudaKernels {
                add: module.load_function("gp_add").map_err(|e| {
                    GPError::BackendError(format!("CUDA gp_add load failed: {:?}", e))
                })?,
                mul: module.load_function("gp_mul").map_err(|e| {
                    GPError::BackendError(format!("CUDA gp_mul load failed: {:?}", e))
                })?,
                relu: module.load_function("gp_relu").map_err(|e| {
                    GPError::BackendError(format!("CUDA gp_relu load failed: {:?}", e))
                })?,
                sigmoid: module.load_function("gp_sigmoid").map_err(|e| {
                    GPError::BackendError(format!("CUDA gp_sigmoid load failed: {:?}", e))
                })?,
                tanh: module.load_function("gp_tanh").map_err(|e| {
                    GPError::BackendError(format!("CUDA gp_tanh load failed: {:?}", e))
                })?,
                relu_backward: module.load_function("gp_relu_backward").map_err(|e| {
                    GPError::BackendError(format!("CUDA gp_relu_backward load failed: {:?}", e))
                })?,
                sigmoid_backward: module.load_function("gp_sigmoid_backward").map_err(|e| {
                    GPError::BackendError(format!("CUDA gp_sigmoid_backward load failed: {:?}", e))
                })?,
                tanh_backward: module.load_function("gp_tanh_backward").map_err(|e| {
                    GPError::BackendError(format!("CUDA gp_tanh_backward load failed: {:?}", e))
                })?,
                add_relu: module.load_function("gp_add_relu").map_err(|e| {
                    GPError::BackendError(format!("CUDA gp_add_relu load failed: {:?}", e))
                })?,
                sgd_update: module.load_function("gp_sgd_update").map_err(|e| {
                    GPError::BackendError(format!("CUDA gp_sgd_update load failed: {:?}", e))
                })?,
                reduce_sum: module.load_function("gp_reduce_sum").map_err(|e| {
                    GPError::BackendError(format!("CUDA gp_reduce_sum load failed: {:?}", e))
                })?,
                matmul: module.load_function("gp_matmul").map_err(|e| {
                    GPError::BackendError(format!("CUDA gp_matmul load failed: {:?}", e))
                })?,
            };
            Ok((context.default_stream(), kernels))
        }))
        .map_err(|_| {
            GPError::BackendError(format!(
                "Failed to load CUDA driver or compiler for context {}",
                device_index
            ))
        })??;

        Ok(Self {
            stream,
            kernels,
            cpu: CPUBackend,
        })
    }

    pub fn device(&self) -> &Arc<cudarc::driver::CudaStream> {
        &self.stream
    }

    fn host(tensor: &Tensor) -> GPResult<Tensor> {
        tensor.to_host()
    }

    fn upload(&self, tensor: Tensor) -> GPResult<Tensor> {
        tensor.to_cuda(&self.stream)
    }

    fn shape_error(expected: &[usize], found: &[usize]) -> GPError {
        GPError::IncompatibleShapes {
            expected: expected.to_vec(),
            found: found.to_vec(),
            exp_len: expected.iter().product(),
            found_len: found.iter().product(),
        }
    }

    fn cuda_slice(tensor: &Tensor) -> GPResult<Arc<CudaSlice<f32>>> {
        match tensor.storage() {
            crate::tensor::Storage::Cuda(storage) => Ok(storage.slice.clone()),
            crate::tensor::Storage::Cpu(_) => Err(GPError::DeviceMismatch(
                "CUDA required, tensor is on CPU".to_string(),
            )),
        }
    }

    fn elementwise_kernel(
        &self,
        kernel: &CudaFunction,
        a: &Tensor,
        b: &Tensor,
    ) -> GPResult<Tensor> {
        if a.shape() != b.shape() {
            return Err(Self::shape_error(a.shape(), b.shape()));
        }

        let a_cuda = self.upload(a.clone())?;
        let b_cuda = self.upload(b.clone())?;
        let a_slice = Self::cuda_slice(&a_cuda)?;
        let b_slice = Self::cuda_slice(&b_cuda)?;
        let mut out_slice = self
            .stream
            .alloc_zeros::<f32>(a.len())
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;
        let n = a.len() as i32;

        let mut builder = self.stream.launch_builder(kernel);
        builder.arg(&mut out_slice);
        builder.arg(a_slice.as_ref());
        builder.arg(b_slice.as_ref());
        builder.arg(&n);
        unsafe {
            builder
                .launch(LaunchConfig::for_num_elems(a.len() as u32))
                .map_err(|e| {
                    GPError::BackendError(format!("CUDA kernel launch failed: {:?}", e))
                })?;
        }

        Ok(Tensor::new_cuda(
            self.stream.clone(),
            Arc::new(out_slice),
            a.shape().to_vec(),
        ))
    }

    fn unary_kernel(&self, kernel: &CudaFunction, x: &Tensor) -> GPResult<Tensor> {
        let x_cuda = self.upload(x.clone())?;
        let x_slice = Self::cuda_slice(&x_cuda)?;
        let mut out_slice = self
            .stream
            .alloc_zeros::<f32>(x.len())
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;
        let n = x.len() as i32;

        let mut builder = self.stream.launch_builder(kernel);
        builder.arg(&mut out_slice);
        builder.arg(x_slice.as_ref());
        builder.arg(&n);
        unsafe {
            builder
                .launch(LaunchConfig::for_num_elems(x.len() as u32))
                .map_err(|e| {
                    GPError::BackendError(format!("CUDA kernel launch failed: {:?}", e))
                })?;
        }

        Ok(Tensor::new_cuda(
            self.stream.clone(),
            Arc::new(out_slice),
            x.shape().to_vec(),
        ))
    }

    fn reduce_sum_output_shape(
        input_shape: &[usize],
        axes: &[usize],
        keep_dims: bool,
    ) -> Vec<usize> {
        if keep_dims {
            let mut shape = input_shape.to_vec();
            for &axis in axes {
                shape[axis] = 1;
            }
            shape
        } else {
            input_shape
                .iter()
                .enumerate()
                .filter_map(|(axis, &size)| (!axes.contains(&axis)).then_some(size))
                .collect()
        }
    }

    fn should_fallback_reduce_sum(input_shape: &[usize], axes: &[usize]) -> bool {
        if input_shape.len() > 8 {
            return true;
        }
        let mut seen = vec![false; input_shape.len()];
        for &axis in axes {
            if axis >= input_shape.len() || seen[axis] {
                return true;
            }
            seen[axis] = true;
        }
        false
    }
}

#[cfg(feature = "cuda")]
impl Backend for CUDABackend {
    fn matmul_t(&self, a: &Tensor, b: &Tensor, trans_a: bool, trans_b: bool) -> GPResult<Tensor> {
        let a_shape = a.shape();
        let b_shape = b.shape();
        if a_shape.len() < 2 || b_shape.len() < 2 {
            return Err(Self::shape_error(a_shape, b_shape));
        }

        let (m, k) = if trans_a {
            (a_shape[1], a_shape[0])
        } else {
            (a_shape[0], a_shape[1])
        };
        let (k_b, n) = if trans_b {
            (b_shape[1], b_shape[0])
        } else {
            (b_shape[0], b_shape[1])
        };
        if k != k_b {
            return Err(Self::shape_error(&[m, k_b], &[m, k]));
        }

        let a_cuda = self.upload(a.clone())?;
        let b_cuda = self.upload(b.clone())?;
        let a_slice = Self::cuda_slice(&a_cuda)?;
        let b_slice = Self::cuda_slice(&b_cuda)?;
        let mut out_slice = self
            .stream
            .alloc_zeros::<f32>(m * n)
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;

        let m_i = m as i32;
        let n_i = n as i32;
        let k_i = k as i32;
        let a_cols = a_shape[1] as i32;
        let b_cols = b_shape[1] as i32;
        let trans_a_i = i32::from(trans_a);
        let trans_b_i = i32::from(trans_b);
        let block = 16u32;
        let cfg = LaunchConfig {
            block_dim: (block, block, 1),
            grid_dim: (
                (n as u32 + block - 1) / block,
                (m as u32 + block - 1) / block,
                1,
            ),
            shared_mem_bytes: 0,
        };

        let mut builder = self.stream.launch_builder(&self.kernels.matmul);
        builder.arg(&mut out_slice);
        builder.arg(a_slice.as_ref());
        builder.arg(b_slice.as_ref());
        builder.arg(&m_i);
        builder.arg(&n_i);
        builder.arg(&k_i);
        builder.arg(&a_cols);
        builder.arg(&b_cols);
        builder.arg(&trans_a_i);
        builder.arg(&trans_b_i);
        unsafe {
            builder.launch(cfg).map_err(|e| {
                GPError::BackendError(format!("CUDA matmul launch failed: {:?}", e))
            })?;
        }

        Ok(Tensor::new_cuda(
            self.stream.clone(),
            Arc::new(out_slice),
            vec![m, n],
        ))
    }

    fn matmul_into(
        &self,
        a: &Tensor,
        b: &Tensor,
        trans_a: bool,
        trans_b: bool,
        out: &mut Tensor,
    ) -> GPResult<()> {
        *out = self.matmul_t(a, b, trans_a, trans_b)?;
        Ok(())
    }

    fn conv2d(
        &self,
        input: &Tensor,
        weight: &Tensor,
        stride: usize,
        padding: usize,
    ) -> GPResult<Tensor> {
        let out = self
            .cpu
            .conv2d(&Self::host(input)?, &Self::host(weight)?, stride, padding)?;
        self.upload(out)
    }

    fn conv2d_backward(
        &self,
        input: &Tensor,
        weight: &Tensor,
        grad_output: &Tensor,
        stride: usize,
        padding: usize,
    ) -> GPResult<(Tensor, Tensor)> {
        let (grad_input, grad_weight) = self.cpu.conv2d_backward(
            &Self::host(input)?,
            &Self::host(weight)?,
            &Self::host(grad_output)?,
            stride,
            padding,
        )?;
        Ok((self.upload(grad_input)?, self.upload(grad_weight)?))
    }

    fn max_pool2d(&self, input: &Tensor, kernel_size: usize, stride: usize) -> GPResult<Tensor> {
        let out = self
            .cpu
            .max_pool2d(&Self::host(input)?, kernel_size, stride)?;
        self.upload(out)
    }

    fn max_pool2d_backward(
        &self,
        input: &Tensor,
        grad_output: &Tensor,
        kernel_size: usize,
        stride: usize,
    ) -> GPResult<Tensor> {
        let out = self.cpu.max_pool2d_backward(
            &Self::host(input)?,
            &Self::host(grad_output)?,
            kernel_size,
            stride,
        )?;
        self.upload(out)
    }

    fn add(&self, a: &Tensor, b: &Tensor) -> GPResult<Tensor> {
        self.elementwise_kernel(&self.kernels.add, a, b)
    }

    fn add_into(&self, a: &Tensor, b: &Tensor, out: &mut Tensor) -> GPResult<()> {
        *out = self.add(a, b)?;
        Ok(())
    }

    fn mul(&self, a: &Tensor, b: &Tensor) -> GPResult<Tensor> {
        self.elementwise_kernel(&self.kernels.mul, a, b)
    }

    fn mul_into(&self, a: &Tensor, b: &Tensor, out: &mut Tensor) -> GPResult<()> {
        *out = self.mul(a, b)?;
        Ok(())
    }

    fn mul_backward(
        &self,
        a: &Tensor,
        b: &Tensor,
        grad_output: &Tensor,
    ) -> GPResult<(Tensor, Tensor)> {
        let (grad_a, grad_b) =
            self.cpu
                .mul_backward(&Self::host(a)?, &Self::host(b)?, &Self::host(grad_output)?)?;
        Ok((self.upload(grad_a)?, self.upload(grad_b)?))
    }

    fn relu(&self, x: &Tensor) -> GPResult<Tensor> {
        self.unary_kernel(&self.kernels.relu, x)
    }

    fn relu_inplace(&self, x: &mut Tensor) -> GPResult<()> {
        *x = self.relu(x)?;
        Ok(())
    }

    fn sigmoid(&self, x: &Tensor) -> GPResult<Tensor> {
        self.unary_kernel(&self.kernels.sigmoid, x)
    }

    fn sigmoid_inplace(&self, x: &mut Tensor) -> GPResult<()> {
        *x = self.sigmoid(x)?;
        Ok(())
    }

    fn tanh(&self, x: &Tensor) -> GPResult<Tensor> {
        self.unary_kernel(&self.kernels.tanh, x)
    }

    fn tanh_inplace(&self, x: &mut Tensor) -> GPResult<()> {
        *x = self.tanh(x)?;
        Ok(())
    }

    fn relu_backward(&self, input: &Tensor, grad_output: &Tensor) -> GPResult<Tensor> {
        self.elementwise_kernel(&self.kernels.relu_backward, input, grad_output)
    }

    fn sigmoid_backward(&self, output: &Tensor, grad_output: &Tensor) -> GPResult<Tensor> {
        self.elementwise_kernel(&self.kernels.sigmoid_backward, output, grad_output)
    }

    fn tanh_backward(&self, output: &Tensor, grad_output: &Tensor) -> GPResult<Tensor> {
        self.elementwise_kernel(&self.kernels.tanh_backward, output, grad_output)
    }

    fn add_relu(&self, a: &Tensor, b: &Tensor) -> GPResult<Tensor> {
        self.elementwise_kernel(&self.kernels.add_relu, a, b)
    }

    fn reduce_sum(&self, input: &Tensor, axes: &[usize], keep_dims: bool) -> GPResult<Tensor> {
        if Self::should_fallback_reduce_sum(input.shape(), axes) {
            let out = self.cpu.reduce_sum(&Self::host(input)?, axes, keep_dims)?;
            return self.upload(out);
        }

        let output_shape = Self::reduce_sum_output_shape(input.shape(), axes, keep_dims);
        let output_len = output_shape.iter().product::<usize>();
        let input_cuda = self.upload(input.clone())?;
        let input_slice = Self::cuda_slice(&input_cuda)?;
        let mut out_slice = self
            .stream
            .alloc_zeros::<f32>(output_len)
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;

        let input_shape_i = input
            .shape()
            .iter()
            .map(|&size| size as i32)
            .collect::<Vec<_>>();
        let output_shape_i = output_shape
            .iter()
            .map(|&size| size as i32)
            .collect::<Vec<_>>();
        let mut axes_mask = vec![0i32; input.shape().len()];
        for &axis in axes {
            axes_mask[axis] = 1;
        }

        let input_shape_dev = self
            .stream
            .clone_htod(input_shape_i.as_slice())
            .map_err(|e| GPError::BackendError(format!("CUDA shape upload failed: {:?}", e)))?;
        let output_shape_dev = self
            .stream
            .clone_htod(output_shape_i.as_slice())
            .map_err(|e| GPError::BackendError(format!("CUDA shape upload failed: {:?}", e)))?;
        let axes_mask_dev = self
            .stream
            .clone_htod(axes_mask.as_slice())
            .map_err(|e| GPError::BackendError(format!("CUDA axes upload failed: {:?}", e)))?;

        let input_len_i = input.len() as i32;
        let output_len_i = output_len as i32;
        let rank_i = input.shape().len() as i32;
        let output_rank_i = output_shape.len() as i32;
        let keep_dims_i = i32::from(keep_dims);

        let mut builder = self.stream.launch_builder(&self.kernels.reduce_sum);
        builder.arg(&mut out_slice);
        builder.arg(input_slice.as_ref());
        builder.arg(&input_shape_dev);
        builder.arg(&output_shape_dev);
        builder.arg(&axes_mask_dev);
        builder.arg(&input_len_i);
        builder.arg(&output_len_i);
        builder.arg(&rank_i);
        builder.arg(&output_rank_i);
        builder.arg(&keep_dims_i);
        unsafe {
            builder
                .launch(LaunchConfig::for_num_elems(output_len as u32))
                .map_err(|e| {
                    GPError::BackendError(format!("CUDA reduce_sum launch failed: {:?}", e))
                })?;
        }

        Ok(Tensor::new_cuda(
            self.stream.clone(),
            Arc::new(out_slice),
            output_shape,
        ))
    }

    fn update_parameter(
        &self,
        param: &mut Tensor,
        grad: &Tensor,
        learning_rate: f32,
    ) -> GPResult<()> {
        if param.shape() != grad.shape() {
            return Err(Self::shape_error(param.shape(), grad.shape()));
        }

        let param_cuda = self.upload(param.clone())?;
        let grad_cuda = self.upload(grad.clone())?;
        let param_slice = Self::cuda_slice(&param_cuda)?;
        let grad_slice = Self::cuda_slice(&grad_cuda)?;
        let mut out_slice = self
            .stream
            .alloc_zeros::<f32>(param.len())
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;
        let n = param.len() as i32;

        let mut builder = self.stream.launch_builder(&self.kernels.sgd_update);
        builder.arg(&mut out_slice);
        builder.arg(param_slice.as_ref());
        builder.arg(grad_slice.as_ref());
        builder.arg(&learning_rate);
        builder.arg(&n);
        unsafe {
            builder
                .launch(LaunchConfig::for_num_elems(param.len() as u32))
                .map_err(|e| {
                    GPError::BackendError(format!("CUDA sgd_update launch failed: {:?}", e))
                })?;
        }

        *param = Tensor::new_cuda(
            self.stream.clone(),
            Arc::new(out_slice),
            param.shape().to_vec(),
        );
        Ok(())
    }
}
