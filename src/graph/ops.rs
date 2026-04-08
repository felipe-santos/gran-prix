//! Operation types for the computation graph.
//!
//! [`OpType`] enumerates all built-in operations (MatMul, activations, etc.)
//! with their forward pass, backward pass (gradient), and shape inference logic.
//!
//! [`Operation`] is a trait for user-defined custom operations.

use serde::{Serialize, Deserialize};
use crate::backend::Backend;
use crate::{GPError, GPResult, Tensor};

/// Enumeration of all built-in computation graph operations.
///
/// Each variant implements forward, backward (gradient), and shape inference.
/// For custom operations, use `Custom(Box<dyn Operation>)`.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum OpType {
    MatMul,
    Conv2D { stride: usize, padding: usize },
    MaxPool2D { kernel_size: usize, stride: usize },
    Add,
    Mul,
    ReLU,
    Tanh,
    Sigmoid,
    /// Row-wise softmax: `softmax(x_i) = exp(x_i) / sum(exp(x_j))` per row.
    /// Numerically stable via max subtraction.
    Softmax,
    Reshape { target_shape: Vec<usize> },
    /// Fused Add + ReLU for reduced memory bandwidth.
    AddReLU,
    /// User-defined operation via the [`Operation`] trait.
    Custom(Box<dyn Operation>),
}

impl OpType {
    pub fn name(&self) -> &str {
        match self {
            OpType::MatMul => "MatMul",
            OpType::Conv2D { .. } => "Conv2D",
            OpType::MaxPool2D { .. } => "MaxPool2D",
            OpType::Add => "Add",
            OpType::Mul => "Mul",
            OpType::ReLU => "ReLU",
            OpType::Tanh => "Tanh",
            OpType::Sigmoid => "Sigmoid",
            OpType::Softmax => "Softmax",
            OpType::Reshape { .. } => "Reshape",
            OpType::AddReLU => "AddReLU",
            OpType::Custom(op) => op.name(),
        }
    }

    // ── Forward Pass ───────────────────────────────────────────────────────

    pub fn forward(&self, inputs: &[&Tensor], backend: &dyn Backend) -> GPResult<Tensor> {
        match self {
            OpType::MatMul => backend.matmul_t(inputs[0], inputs[1], false, false),
            OpType::Conv2D { stride, padding } => backend.conv2d(inputs[0], inputs[1], *stride, *padding),
            OpType::MaxPool2D { kernel_size, stride } => backend.max_pool2d(inputs[0], *kernel_size, *stride),
            OpType::Add => backend.add(inputs[0], inputs[1]),
            OpType::Mul => backend.mul(inputs[0], inputs[1]),
            OpType::ReLU => backend.relu(inputs[0]),
            OpType::Tanh => backend.tanh(inputs[0]),
            OpType::Sigmoid => backend.sigmoid(inputs[0]),
            OpType::Softmax => softmax_forward(inputs[0]),
            OpType::Reshape { target_shape } => {
                let t = inputs[0].clone();
                Ok(t.into_shape(target_shape.as_slice())?.into_dyn())
            }
            OpType::AddReLU => backend.add_relu(inputs[0], inputs[1]),
            OpType::Custom(op) => op.forward(inputs, backend),
        }
    }

    /// In-place forward pass. Falls back to allocating version for complex ops.
    pub fn forward_inplace(&self, inputs: &[&Tensor], out: &mut Tensor, backend: &dyn Backend) -> GPResult<()> {
        match self {
            OpType::MatMul => backend.matmul_into(inputs[0], inputs[1], false, false, out),
            OpType::Add => backend.add_into(inputs[0], inputs[1], out),
            OpType::Mul => backend.mul_into(inputs[0], inputs[1], out),
            OpType::ReLU => elementwise_inplace(inputs[0], out, |x| if x < 0.0 { 0.0 } else { x }),
            OpType::Tanh => elementwise_inplace(inputs[0], out, |x| x.tanh()),
            OpType::Sigmoid => elementwise_inplace(inputs[0], out, |x| 1.0 / (1.0 + (-x).exp())),
            OpType::AddReLU => { backend.relu_inplace(out)?; Ok(()) }
            OpType::Custom(op) => op.forward_inplace(inputs, out, backend),
            _ => {
                let res = self.forward(inputs, backend)?;
                out.copy_from(&res)
            }
        }
    }

    // ── Backward Pass (Gradient) ───────────────────────────────────────────

    pub fn backward(&self, inputs: &[&Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        match self {
            OpType::MatMul => {
                let grad_a = backend.matmul_t(grad_output, inputs[1], false, true)?;
                let grad_b = backend.matmul_t(inputs[0], grad_output, true, false)?;
                Ok(vec![grad_a, grad_b])
            }
            OpType::Conv2D { stride, padding } => {
                let (gi, gw) = backend.conv2d_backward(inputs[0], inputs[1], grad_output, *stride, *padding)?;
                Ok(vec![gi, gw])
            }
            OpType::MaxPool2D { kernel_size, stride } => {
                Ok(vec![backend.max_pool2d_backward(inputs[0], grad_output, *kernel_size, *stride)?])
            }
            OpType::Add => Ok(vec![
                resolve_grad(inputs[0].shape(), grad_output, backend)?,
                resolve_grad(inputs[1].shape(), grad_output, backend)?,
            ]),
            OpType::Mul => {
                let (ga, gb) = backend.mul_backward(inputs[0], inputs[1], grad_output)?;
                Ok(vec![
                    resolve_grad(inputs[0].shape(), &ga, backend)?,
                    resolve_grad(inputs[1].shape(), &gb, backend)?,
                ])
            }
            OpType::ReLU => Ok(vec![backend.relu_backward(inputs[0], grad_output)?]),
            OpType::Tanh => {
                let y = backend.tanh(inputs[0])?;
                Ok(vec![backend.tanh_backward(&y, grad_output)?])
            }
            OpType::Sigmoid => {
                let y = backend.sigmoid(inputs[0])?;
                Ok(vec![backend.sigmoid_backward(&y, grad_output)?])
            }
            OpType::Softmax => softmax_backward(inputs[0], grad_output),
            OpType::Reshape { .. } => {
                let grad = grad_output.clone().into_shape(inputs[0].shape())?.into_dyn();
                Ok(vec![grad])
            }
            OpType::AddReLU => {
                let relu_grad = backend.relu_backward(&backend.add(inputs[0], inputs[1])?, grad_output)?;
                Ok(vec![
                    resolve_grad(inputs[0].shape(), &relu_grad, backend)?,
                    resolve_grad(inputs[1].shape(), &relu_grad, backend)?,
                ])
            }
            OpType::Custom(op) => op.backward(inputs, grad_output, backend),
        }
    }

    // ── Shape Inference ────────────────────────────────────────────────────

    pub fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        match self {
            OpType::MatMul => {
                if input_shapes[0][1] != input_shapes[1][0] {
                    return Err(GPError::IncompatibleShapes {
                        expected: vec![input_shapes[0][0], input_shapes[1][0]],
                        found: vec![input_shapes[0][1], input_shapes[1][0]],
                        exp_len: input_shapes[0][1],
                        found_len: input_shapes[1][0],
                    });
                }
                Ok(vec![input_shapes[0][0], input_shapes[1][1]])
            }
            OpType::Conv2D { stride, padding } => {
                let (n, _ci, h, w) = (input_shapes[0][0], input_shapes[0][1], input_shapes[0][2], input_shapes[0][3]);
                let (co, _ci_w, kh, kw) = (input_shapes[1][0], input_shapes[1][1], input_shapes[1][2], input_shapes[1][3]);
                Ok(vec![n, co, (h + 2 * padding - kh) / stride + 1, (w + 2 * padding - kw) / stride + 1])
            }
            OpType::MaxPool2D { kernel_size, stride } => {
                let (n, c, h, w) = (input_shapes[0][0], input_shapes[0][1], input_shapes[0][2], input_shapes[0][3]);
                Ok(vec![n, c, (h - kernel_size) / stride + 1, (w - kernel_size) / stride + 1])
            }
            OpType::Add | OpType::Mul | OpType::AddReLU => {
                if input_shapes[0] != input_shapes[1] {
                    let exp_total: usize = input_shapes[0].iter().product();
                    let found_total: usize = input_shapes[1].iter().product();
                    return Err(GPError::IncompatibleShapes {
                        expected: input_shapes[0].clone(),
                        found: input_shapes[1].clone(),
                        exp_len: exp_total,
                        found_len: found_total,
                    });
                }
                Ok(input_shapes[0].clone())
            }
            OpType::ReLU | OpType::Sigmoid | OpType::Tanh | OpType::Softmax => {
                Ok(input_shapes[0].clone())
            }
            OpType::Reshape { target_shape } => Ok(target_shape.clone()),
            OpType::Custom(op) => op.output_shape(input_shapes),
        }
    }
}

// ── Helper Functions ───────────────────────────────────────────────────────

/// Element-wise in-place operation: `out[i] = f(in[i])`.
fn elementwise_inplace(input: &Tensor, out: &mut Tensor, f: fn(f32) -> f32) -> GPResult<()> {
    let in_len = input.len();
    let out_len = out.len();
    if in_len != out_len {
        return Err(GPError::IncompatibleShapes {
            expected: out.shape().to_vec(),
            found: input.shape().to_vec(),
            exp_len: out_len,
            found_len: in_len,
        });
    }
    let in_slice = input.as_slice()?;
    let out_slice = out.as_slice_mut()?;
    for i in 0..out_slice.len() {
        out_slice[i] = f(in_slice[i]);
    }
    Ok(())
}

/// Numerically stable row-wise softmax forward.
fn softmax_forward(x: &Tensor) -> GPResult<Tensor> {
    let shape = x.shape();
    let rows = shape[0];
    let cols = shape[1];
    let x_slice = x.as_slice()?;
    let mut out = vec![0.0f32; rows * cols];

    for r in 0..rows {
        let rs = r * cols;
        let row = &x_slice[rs..rs + cols];
        let max_val = row.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let mut sum = 0.0f32;
        for c in 0..cols {
            let e = (row[c] - max_val).exp();
            out[rs + c] = e;
            sum += e;
        }
        if sum > 0.0 {
            for c in 0..cols { out[rs + c] /= sum; }
        }
    }

    Tensor::from_shape_vec(shape, out)
}

/// Softmax backward: `dL/dx_i = y_i * (dL/dy_i - dot(dL/dy, y))`.
fn softmax_backward(x: &Tensor, grad_output: &Tensor) -> GPResult<Vec<Tensor>> {
    let shape = x.shape();
    let rows = shape[0];
    let cols = shape[1];

    // Recompute softmax output
    let x_slice = x.as_slice()?;
    let mut y = vec![0.0f32; rows * cols];
    for r in 0..rows {
        let rs = r * cols;
        let row = &x_slice[rs..rs + cols];
        let max_val = row.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let mut sum = 0.0f32;
        for c in 0..cols {
            let e = (row[c] - max_val).exp();
            y[rs + c] = e;
            sum += e;
        }
        if sum > 0.0 {
            for c in 0..cols { y[rs + c] /= sum; }
        }
    }

    // Compute gradient
    let go = grad_output.as_slice()?;
    let mut grad = vec![0.0f32; rows * cols];
    for r in 0..rows {
        let rs = r * cols;
        let dot: f32 = (0..cols).map(|c| go[rs + c] * y[rs + c]).sum();
        for c in 0..cols {
            grad[rs + c] = y[rs + c] * (go[rs + c] - dot);
        }
    }

    Ok(vec![Tensor::from_shape_vec(shape, grad)?])
}

/// Resolves gradient shape mismatches via reduction (for broadcasting).
pub(crate) fn resolve_grad(target_shape: &[usize], grad: &Tensor, backend: &dyn Backend) -> GPResult<Tensor> {
    if target_shape == grad.shape() {
        return Ok(grad.clone());
    }
    let grad_dims = grad.shape().len();
    let target_dims = target_shape.len();
    let mut axes = Vec::new();

    if grad_dims > target_dims {
        for i in 0..(grad_dims - target_dims) {
            axes.push(i);
        }
    }
    for i in 0..target_dims {
        let g_idx = grad_dims - 1 - i;
        let t_idx = target_dims - 1 - i;
        if target_shape[t_idx] == 1 && grad.shape()[g_idx] > 1 {
            axes.push(g_idx);
        }
    }
    if axes.is_empty() {
        return Ok(grad.clone());
    }

    backend.reduce_sum(grad, &axes, true)
        .and_then(|t| {
            if t.shape().len() != target_shape.len() {
                let val = t.try_view()?.to_owned().into_shape(target_shape)
                    .map_err(|_| GPError::IncompatibleShapes {
                        expected: target_shape.to_vec(),
                        found: t.shape().to_vec(),
                        exp_len: target_shape.iter().product(),
                        found_len: t.len(),
                    })?;
                Ok(val.into_dyn().into())
            } else {
                Ok(t)
            }
        })
}

// ── Custom Operation Trait ─────────────────────────────────────────────────

/// Trait for user-defined graph operations.
///
/// Implement this to add custom operations beyond the built-in [`OpType`] variants.
#[typetag::serde(tag = "type")]
pub trait Operation: Send + Sync + std::fmt::Debug {
    fn name(&self) -> &str;
    fn forward(&self, inputs: &[&Tensor], backend: &dyn Backend) -> GPResult<Tensor>;
    fn backward(&self, inputs: &[&Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>>;
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>>;

    fn forward_inplace(&self, inputs: &[&Tensor], out: &mut Tensor, backend: &dyn Backend) -> GPResult<()> {
        let res = self.forward(inputs, backend)?;
        out.copy_from(&res)
    }

    fn clone_box(&self) -> Box<dyn Operation>;
}

impl Clone for Box<dyn Operation> {
    fn clone(&self) -> Self {
        self.clone_box()
    }
}
