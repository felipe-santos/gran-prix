//! CUDA backend — experimental.
//!
//! The feature currently provides CUDA tensor storage and native kernels for
//! the core backend operations.

#[cfg(feature = "cuda")]
use std::panic::{catch_unwind, AssertUnwindSafe};
#[cfg(feature = "cuda")]
use std::sync::Arc;

#[cfg(feature = "cuda")]
use crate::backend::Backend;
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
}

#[cfg(feature = "cuda")]
#[derive(Debug)]
struct CudaKernels {
    add: CudaFunction,
    mul: CudaFunction,
    mul_backward: CudaFunction,
    relu: CudaFunction,
    sigmoid: CudaFunction,
    tanh: CudaFunction,
    relu_backward: CudaFunction,
    sigmoid_backward: CudaFunction,
    tanh_backward: CudaFunction,
    add_relu: CudaFunction,
    sgd_update: CudaFunction,
    reduce_sum: CudaFunction,
    max_pool2d: CudaFunction,
    max_pool2d_backward: CudaFunction,
    conv2d: CudaFunction,
    conv2d_grad_input: CudaFunction,
    conv2d_grad_weight: CudaFunction,
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
                mul_backward: module.load_function("gp_mul_backward").map_err(|e| {
                    GPError::BackendError(format!("CUDA gp_mul_backward load failed: {:?}", e))
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
                max_pool2d: module.load_function("gp_max_pool2d").map_err(|e| {
                    GPError::BackendError(format!("CUDA gp_max_pool2d load failed: {:?}", e))
                })?,
                max_pool2d_backward: module.load_function("gp_max_pool2d_backward").map_err(
                    |e| {
                        GPError::BackendError(format!(
                            "CUDA gp_max_pool2d_backward load failed: {:?}",
                            e
                        ))
                    },
                )?,
                conv2d: module.load_function("gp_conv2d").map_err(|e| {
                    GPError::BackendError(format!("CUDA gp_conv2d load failed: {:?}", e))
                })?,
                conv2d_grad_input: module.load_function("gp_conv2d_grad_input").map_err(|e| {
                    GPError::BackendError(format!("CUDA gp_conv2d_grad_input load failed: {:?}", e))
                })?,
                conv2d_grad_weight: module.load_function("gp_conv2d_grad_weight").map_err(|e| {
                    GPError::BackendError(format!(
                        "CUDA gp_conv2d_grad_weight load failed: {:?}",
                        e
                    ))
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

        Ok(Self { stream, kernels })
    }

    pub fn device(&self) -> &Arc<cudarc::driver::CudaStream> {
        &self.stream
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

    fn validate_reduce_sum_axes(input_shape: &[usize], axes: &[usize]) -> GPResult<()> {
        if input_shape.len() > 8 {
            return Err(GPError::NotImplemented(format!(
                "CUDA reduce_sum supports tensors up to rank 8, got rank {}",
                input_shape.len()
            )));
        }
        let mut seen = vec![false; input_shape.len()];
        for &axis in axes {
            if axis >= input_shape.len() {
                return Err(GPError::TensorError(format!(
                    "reduce_sum axis {} out of bounds for rank {}",
                    axis,
                    input_shape.len()
                )));
            }
            if seen[axis] {
                return Err(GPError::TensorError(format!(
                    "reduce_sum axis {} appears more than once",
                    axis
                )));
            }
            seen[axis] = true;
        }
        Ok(())
    }

    fn conv2d_dims(
        input_shape: &[usize],
        weight_shape: &[usize],
        stride: usize,
        padding: usize,
    ) -> GPResult<(
        usize,
        usize,
        usize,
        usize,
        usize,
        usize,
        usize,
        usize,
        usize,
    )> {
        if input_shape.len() != 4 || weight_shape.len() != 4 {
            return Err(Self::shape_error(input_shape, weight_shape));
        }

        let (n, ci, h, w) = (
            input_shape[0],
            input_shape[1],
            input_shape[2],
            input_shape[3],
        );
        let (co, weight_ci, kh, kw) = (
            weight_shape[0],
            weight_shape[1],
            weight_shape[2],
            weight_shape[3],
        );
        if ci != weight_ci || stride == 0 || h + 2 * padding < kh || w + 2 * padding < kw {
            return Err(Self::shape_error(&[0, ci, kh, kw], weight_shape));
        }

        let oh = (h + 2 * padding - kh) / stride + 1;
        let ow = (w + 2 * padding - kw) / stride + 1;
        Ok((n, ci, h, w, co, kh, kw, oh, ow))
    }

    fn max_pool2d_dims(
        input_shape: &[usize],
        kernel_size: usize,
        stride: usize,
    ) -> GPResult<(usize, usize, usize, usize, usize, usize)> {
        if input_shape.len() != 4 || kernel_size == 0 || stride == 0 {
            return Err(Self::shape_error(&[0, 0, kernel_size, stride], input_shape));
        }

        let (n, c, h, w) = (
            input_shape[0],
            input_shape[1],
            input_shape[2],
            input_shape[3],
        );
        if h < kernel_size || w < kernel_size {
            return Err(Self::shape_error(
                &[n, c, kernel_size, kernel_size],
                input_shape,
            ));
        }

        let oh = (h - kernel_size) / stride + 1;
        let ow = (w - kernel_size) / stride + 1;
        Ok((n, c, h, w, oh, ow))
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
        let (n, ci, h, w, co, kh, kw, oh, ow) =
            Self::conv2d_dims(input.shape(), weight.shape(), stride, padding)?;
        let input_cuda = self.upload(input.clone())?;
        let weight_cuda = self.upload(weight.clone())?;
        let input_slice = Self::cuda_slice(&input_cuda)?;
        let weight_slice = Self::cuda_slice(&weight_cuda)?;
        let mut out_slice = self
            .stream
            .alloc_zeros::<f32>(n * co * oh * ow)
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;

        let n_i = n as i32;
        let ci_i = ci as i32;
        let h_i = h as i32;
        let w_i = w as i32;
        let co_i = co as i32;
        let kh_i = kh as i32;
        let kw_i = kw as i32;
        let oh_i = oh as i32;
        let ow_i = ow as i32;
        let stride_i = stride as i32;
        let padding_i = padding as i32;

        let mut builder = self.stream.launch_builder(&self.kernels.conv2d);
        builder.arg(&mut out_slice);
        builder.arg(input_slice.as_ref());
        builder.arg(weight_slice.as_ref());
        builder.arg(&n_i);
        builder.arg(&ci_i);
        builder.arg(&h_i);
        builder.arg(&w_i);
        builder.arg(&co_i);
        builder.arg(&kh_i);
        builder.arg(&kw_i);
        builder.arg(&oh_i);
        builder.arg(&ow_i);
        builder.arg(&stride_i);
        builder.arg(&padding_i);
        unsafe {
            builder
                .launch(LaunchConfig::for_num_elems((n * co * oh * ow) as u32))
                .map_err(|e| {
                    GPError::BackendError(format!("CUDA conv2d launch failed: {:?}", e))
                })?;
        }

        Ok(Tensor::new_cuda(
            self.stream.clone(),
            Arc::new(out_slice),
            vec![n, co, oh, ow],
        ))
    }

    fn conv2d_backward(
        &self,
        input: &Tensor,
        weight: &Tensor,
        grad_output: &Tensor,
        stride: usize,
        padding: usize,
    ) -> GPResult<(Tensor, Tensor)> {
        let (n, ci, h, w, co, kh, kw, oh, ow) =
            Self::conv2d_dims(input.shape(), weight.shape(), stride, padding)?;
        if grad_output.shape() != [n, co, oh, ow] {
            return Err(Self::shape_error(&[n, co, oh, ow], grad_output.shape()));
        }

        let input_cuda = self.upload(input.clone())?;
        let weight_cuda = self.upload(weight.clone())?;
        let grad_cuda = self.upload(grad_output.clone())?;
        let input_slice = Self::cuda_slice(&input_cuda)?;
        let weight_slice = Self::cuda_slice(&weight_cuda)?;
        let grad_slice = Self::cuda_slice(&grad_cuda)?;
        let mut grad_input_slice = self
            .stream
            .alloc_zeros::<f32>(input.len())
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;
        let mut grad_weight_slice = self
            .stream
            .alloc_zeros::<f32>(weight.len())
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;

        let n_i = n as i32;
        let ci_i = ci as i32;
        let h_i = h as i32;
        let w_i = w as i32;
        let co_i = co as i32;
        let kh_i = kh as i32;
        let kw_i = kw as i32;
        let oh_i = oh as i32;
        let ow_i = ow as i32;
        let stride_i = stride as i32;
        let padding_i = padding as i32;

        let mut grad_input_builder = self.stream.launch_builder(&self.kernels.conv2d_grad_input);
        grad_input_builder.arg(&mut grad_input_slice);
        grad_input_builder.arg(weight_slice.as_ref());
        grad_input_builder.arg(grad_slice.as_ref());
        grad_input_builder.arg(&n_i);
        grad_input_builder.arg(&ci_i);
        grad_input_builder.arg(&h_i);
        grad_input_builder.arg(&w_i);
        grad_input_builder.arg(&co_i);
        grad_input_builder.arg(&kh_i);
        grad_input_builder.arg(&kw_i);
        grad_input_builder.arg(&oh_i);
        grad_input_builder.arg(&ow_i);
        grad_input_builder.arg(&stride_i);
        grad_input_builder.arg(&padding_i);
        unsafe {
            grad_input_builder
                .launch(LaunchConfig::for_num_elems(input.len() as u32))
                .map_err(|e| {
                    GPError::BackendError(format!("CUDA conv2d grad_input launch failed: {:?}", e))
                })?;
        }

        let mut grad_weight_builder = self.stream.launch_builder(&self.kernels.conv2d_grad_weight);
        grad_weight_builder.arg(&mut grad_weight_slice);
        grad_weight_builder.arg(input_slice.as_ref());
        grad_weight_builder.arg(grad_slice.as_ref());
        grad_weight_builder.arg(&n_i);
        grad_weight_builder.arg(&ci_i);
        grad_weight_builder.arg(&h_i);
        grad_weight_builder.arg(&w_i);
        grad_weight_builder.arg(&co_i);
        grad_weight_builder.arg(&kh_i);
        grad_weight_builder.arg(&kw_i);
        grad_weight_builder.arg(&oh_i);
        grad_weight_builder.arg(&ow_i);
        grad_weight_builder.arg(&stride_i);
        grad_weight_builder.arg(&padding_i);
        unsafe {
            grad_weight_builder
                .launch(LaunchConfig::for_num_elems(weight.len() as u32))
                .map_err(|e| {
                    GPError::BackendError(format!("CUDA conv2d grad_weight launch failed: {:?}", e))
                })?;
        }

        Ok((
            Tensor::new_cuda(
                self.stream.clone(),
                Arc::new(grad_input_slice),
                input.shape().to_vec(),
            ),
            Tensor::new_cuda(
                self.stream.clone(),
                Arc::new(grad_weight_slice),
                weight.shape().to_vec(),
            ),
        ))
    }

    fn max_pool2d(&self, input: &Tensor, kernel_size: usize, stride: usize) -> GPResult<Tensor> {
        let (n, c, h, w, oh, ow) = Self::max_pool2d_dims(input.shape(), kernel_size, stride)?;
        let input_cuda = self.upload(input.clone())?;
        let input_slice = Self::cuda_slice(&input_cuda)?;
        let mut out_slice = self
            .stream
            .alloc_zeros::<f32>(n * c * oh * ow)
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;

        let n_i = n as i32;
        let c_i = c as i32;
        let h_i = h as i32;
        let w_i = w as i32;
        let oh_i = oh as i32;
        let ow_i = ow as i32;
        let kernel_i = kernel_size as i32;
        let stride_i = stride as i32;

        let mut builder = self.stream.launch_builder(&self.kernels.max_pool2d);
        builder.arg(&mut out_slice);
        builder.arg(input_slice.as_ref());
        builder.arg(&n_i);
        builder.arg(&c_i);
        builder.arg(&h_i);
        builder.arg(&w_i);
        builder.arg(&oh_i);
        builder.arg(&ow_i);
        builder.arg(&kernel_i);
        builder.arg(&stride_i);
        unsafe {
            builder
                .launch(LaunchConfig::for_num_elems((n * c * oh * ow) as u32))
                .map_err(|e| {
                    GPError::BackendError(format!("CUDA max_pool2d launch failed: {:?}", e))
                })?;
        }

        Ok(Tensor::new_cuda(
            self.stream.clone(),
            Arc::new(out_slice),
            vec![n, c, oh, ow],
        ))
    }

    fn max_pool2d_backward(
        &self,
        input: &Tensor,
        grad_output: &Tensor,
        kernel_size: usize,
        stride: usize,
    ) -> GPResult<Tensor> {
        let (n, c, h, w, expected_oh, expected_ow) =
            Self::max_pool2d_dims(input.shape(), kernel_size, stride)?;
        let grad_shape = grad_output.shape();
        if grad_shape.len() != 4 {
            return Err(Self::shape_error(
                &[n, c, expected_oh, expected_ow],
                grad_shape,
            ));
        }
        if grad_shape != [n, c, expected_oh, expected_ow] {
            return Err(Self::shape_error(
                &[n, c, expected_oh, expected_ow],
                grad_shape,
            ));
        }

        let input_cuda = self.upload(input.clone())?;
        let grad_cuda = self.upload(grad_output.clone())?;
        let input_slice = Self::cuda_slice(&input_cuda)?;
        let grad_slice = Self::cuda_slice(&grad_cuda)?;
        let mut out_slice = self
            .stream
            .alloc_zeros::<f32>(input.len())
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;

        let n_i = n as i32;
        let c_i = c as i32;
        let h_i = h as i32;
        let w_i = w as i32;
        let oh_i = expected_oh as i32;
        let ow_i = expected_ow as i32;
        let kernel_i = kernel_size as i32;
        let stride_i = stride as i32;

        let mut builder = self
            .stream
            .launch_builder(&self.kernels.max_pool2d_backward);
        builder.arg(&mut out_slice);
        builder.arg(input_slice.as_ref());
        builder.arg(grad_slice.as_ref());
        builder.arg(&n_i);
        builder.arg(&c_i);
        builder.arg(&h_i);
        builder.arg(&w_i);
        builder.arg(&oh_i);
        builder.arg(&ow_i);
        builder.arg(&kernel_i);
        builder.arg(&stride_i);
        unsafe {
            builder
                .launch(LaunchConfig::for_num_elems(grad_output.len() as u32))
                .map_err(|e| {
                    GPError::BackendError(format!(
                        "CUDA max_pool2d_backward launch failed: {:?}",
                        e
                    ))
                })?;
        }

        Ok(Tensor::new_cuda(
            self.stream.clone(),
            Arc::new(out_slice),
            input.shape().to_vec(),
        ))
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
        if a.shape() != b.shape() {
            return Err(Self::shape_error(a.shape(), b.shape()));
        }
        if a.shape() != grad_output.shape() {
            return Err(Self::shape_error(a.shape(), grad_output.shape()));
        }

        let a_cuda = self.upload(a.clone())?;
        let b_cuda = self.upload(b.clone())?;
        let grad_cuda = self.upload(grad_output.clone())?;
        let a_slice = Self::cuda_slice(&a_cuda)?;
        let b_slice = Self::cuda_slice(&b_cuda)?;
        let grad_slice = Self::cuda_slice(&grad_cuda)?;
        let mut grad_a_slice = self
            .stream
            .alloc_zeros::<f32>(a.len())
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;
        let mut grad_b_slice = self
            .stream
            .alloc_zeros::<f32>(b.len())
            .map_err(|e| GPError::BackendError(format!("CUDA alloc failed: {:?}", e)))?;
        let n = a.len() as i32;

        let mut builder = self.stream.launch_builder(&self.kernels.mul_backward);
        builder.arg(&mut grad_a_slice);
        builder.arg(&mut grad_b_slice);
        builder.arg(a_slice.as_ref());
        builder.arg(b_slice.as_ref());
        builder.arg(grad_slice.as_ref());
        builder.arg(&n);
        unsafe {
            builder
                .launch(LaunchConfig::for_num_elems(a.len() as u32))
                .map_err(|e| {
                    GPError::BackendError(format!("CUDA mul_backward launch failed: {:?}", e))
                })?;
        }

        Ok((
            Tensor::new_cuda(
                self.stream.clone(),
                Arc::new(grad_a_slice),
                a.shape().to_vec(),
            ),
            Tensor::new_cuda(
                self.stream.clone(),
                Arc::new(grad_b_slice),
                b.shape().to_vec(),
            ),
        ))
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
        Self::validate_reduce_sum_axes(input.shape(), axes)?;

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
