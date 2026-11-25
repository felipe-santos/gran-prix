use crate::backend::Backend;
use crate::{GPError, GPResult, Tensor};
use ndarray::Zip;

#[derive(Debug)]
pub struct CPUBackend;

impl CPUBackend {
    fn shape_error(expected: &[usize], found: &[usize]) -> GPError {
        GPError::IncompatibleShapes {
            expected: expected.to_vec(),
            found: found.to_vec(),
            exp_len: expected.iter().product(),
            found_len: found.iter().product(),
        }
    }

    fn matmul_dims(
        a_shape: &[usize],
        b_shape: &[usize],
        trans_a: bool,
        trans_b: bool,
    ) -> GPResult<(usize, usize, usize)> {
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
        Ok((m, n, k))
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
        let padded_h = padding
            .checked_mul(2)
            .and_then(|p| h.checked_add(p))
            .ok_or_else(|| Self::shape_error(&[n, ci, h, w], weight_shape))?;
        let padded_w = padding
            .checked_mul(2)
            .and_then(|p| w.checked_add(p))
            .ok_or_else(|| Self::shape_error(&[n, ci, h, w], weight_shape))?;
        if ci != weight_ci || stride == 0 || padded_h < kh || padded_w < kw {
            return Err(Self::shape_error(&[n, ci, h, w], weight_shape));
        }

        let oh = (padded_h - kh) / stride + 1;
        let ow = (padded_w - kw) / stride + 1;
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

impl Backend for CPUBackend {
    fn matmul_t(&self, a: &Tensor, b: &Tensor, trans_a: bool, trans_b: bool) -> GPResult<Tensor> {
        let (m, n, _) = Self::matmul_dims(a.shape(), b.shape(), trans_a, trans_b)?;
        let mut res = Tensor::new_zeros(&[m, n]);
        self.matmul_into(a, b, trans_a, trans_b, &mut res)?;
        Ok(res)
    }

    fn matmul_into(
        &self,
        a: &Tensor,
        b: &Tensor,
        trans_a: bool,
        trans_b: bool,
        out: &mut Tensor,
    ) -> GPResult<()> {
        let a_shape = a.shape();
        let b_shape = b.shape();
        let out_shape = out.shape();

        let (l_rows, r_cols, l_cols) = Self::matmul_dims(a_shape, b_shape, trans_a, trans_b)?;
        if out_shape.len() < 2 || out_shape[0] != l_rows || out_shape[1] != r_cols {
            return Err(GPError::IncompatibleShapes {
                expected: vec![l_rows, r_cols],
                found: out_shape.to_vec(),
                exp_len: l_rows * r_cols,
                found_len: out.len(),
            });
        }

        let a_slice = a.as_slice()?;
        let b_slice = b.as_slice()?;
        let out_slice = out.as_slice_mut()?;

        // MANUAL MATMUL - Purely safe Rust, no library calls
        for i in 0..l_rows {
            let i_n = i * r_cols;
            for j in 0..r_cols {
                let mut sum = 0.0;
                for l in 0..l_cols {
                    let a_idx = if trans_a {
                        l * a_shape[1] + i
                    } else {
                        i * a_shape[1] + l
                    };
                    let b_idx = if trans_b {
                        j * b_shape[1] + l
                    } else {
                        l * b_shape[1] + j
                    };

                    // Boundary check via slice indexing is safe in Rust
                    sum += a_slice[a_idx] * b_slice[b_idx];
                }
                out_slice[i_n + j] = sum;
            }
        }
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
        let input_view = input.try_view()?;
        let weight_view = weight.try_view()?;

        let input4 = input_view
            .into_dimensionality::<ndarray::Ix4>()
            .map_err(|_| GPError::IncompatibleShapes {
                expected: vec![0, 0, 0, 0],
                found: input.shape().to_vec(),
                exp_len: 0,
                found_len: input.len(),
            })?;
        let weight4 = weight_view
            .into_dimensionality::<ndarray::Ix4>()
            .map_err(|_| GPError::IncompatibleShapes {
                expected: vec![0, 0, 0, 0],
                found: weight.shape().to_vec(),
                exp_len: 0,
                found_len: weight.len(),
            })?;

        let mut output = ndarray::Array4::<f32>::zeros((n, co, oh, ow));

        let kernel = |(ni, mut out_batch): (usize, ndarray::ArrayViewMut3<f32>)| {
            for coi in 0..co {
                for hi in 0..oh {
                    for wi in 0..ow {
                        let mut sum = 0.0;
                        for cii in 0..ci {
                            for k_hi in 0..kh {
                                for k_wi in 0..kw {
                                    let in_h = (hi * stride) as i32 + k_hi as i32 - padding as i32;
                                    let in_w = (wi * stride) as i32 + k_wi as i32 - padding as i32;

                                    if in_h >= 0 && in_h < h as i32 && in_w >= 0 && in_w < w as i32
                                    {
                                        sum += input4[[ni, cii, in_h as usize, in_w as usize]]
                                            * weight4[[coi, cii, k_hi, k_wi]];
                                    }
                                }
                            }
                        }
                        out_batch[[coi, hi, wi]] = sum;
                    }
                }
            }
        };

        #[cfg(feature = "rayon")]
        {
            use rayon::prelude::*;
            output
                .axis_iter_mut(ndarray::Axis(0))
                .into_par_iter()
                .enumerate()
                .for_each(kernel);
        }

        #[cfg(not(feature = "rayon"))]
        {
            output
                .axis_iter_mut(ndarray::Axis(0))
                .enumerate()
                .for_each(kernel);
        }

        Ok(output.into_dyn().into())
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

        let input_view = input.try_view()?;
        let weight_view = weight.try_view()?;
        let grad_out_view = grad_output.try_view()?;

        let input4 = input_view
            .into_dimensionality::<ndarray::Ix4>()
            .map_err(|_| GPError::IncompatibleShapes {
                expected: vec![0, 0, 0, 0],
                found: input.shape().to_vec(),
                exp_len: 0,
                found_len: input.len(),
            })?;
        let weight4 = weight_view
            .into_dimensionality::<ndarray::Ix4>()
            .map_err(|_| GPError::IncompatibleShapes {
                expected: vec![0, 0, 0, 0],
                found: weight.shape().to_vec(),
                exp_len: 0,
                found_len: weight.len(),
            })?;
        let grad_out4 = grad_out_view
            .into_dimensionality::<ndarray::Ix4>()
            .map_err(|_| GPError::IncompatibleShapes {
                expected: vec![0, 0, 0, 0],
                found: grad_output.shape().to_vec(),
                exp_len: 0,
                found_len: grad_output.len(),
            })?;

        let mut grad_input = ndarray::Array4::<f32>::zeros((n, ci, h, w));
        let mut grad_weight = ndarray::Array4::<f32>::zeros((co, ci, kh, kw));

        let kernel_grad_input = |(ni, mut g_in_batch): (usize, ndarray::ArrayViewMut3<f32>)| {
            for coi in 0..co {
                for hi in 0..oh {
                    for wi in 0..ow {
                        let g_out = grad_out4[[ni, coi, hi, wi]];
                        for cii in 0..ci {
                            for k_hi in 0..kh {
                                for k_wi in 0..kw {
                                    let in_h = (hi * stride) as i32 + k_hi as i32 - padding as i32;
                                    let in_w = (wi * stride) as i32 + k_wi as i32 - padding as i32;

                                    if in_h >= 0 && in_h < h as i32 && in_w >= 0 && in_w < w as i32
                                    {
                                        g_in_batch[[cii, in_h as usize, in_w as usize]] +=
                                            g_out * weight4[[coi, cii, k_hi, k_wi]];
                                    }
                                }
                            }
                        }
                    }
                }
            }
        };

        #[cfg(feature = "rayon")]
        {
            use rayon::prelude::*;
            grad_input
                .axis_iter_mut(ndarray::Axis(0))
                .into_par_iter()
                .enumerate()
                .for_each(kernel_grad_input);
        }
        #[cfg(not(feature = "rayon"))]
        {
            grad_input
                .axis_iter_mut(ndarray::Axis(0))
                .enumerate()
                .for_each(kernel_grad_input);
        }

        let kernel_grad_weight = |(coi, mut g_w_co): (usize, ndarray::ArrayViewMut3<f32>)| {
            for ni in 0..n {
                for hi in 0..oh {
                    for wi in 0..ow {
                        let g_out = grad_out4[[ni, coi, hi, wi]];
                        for cii in 0..ci {
                            for k_hi in 0..kh {
                                for k_wi in 0..kw {
                                    let in_h = (hi * stride) as i32 + k_hi as i32 - padding as i32;
                                    let in_w = (wi * stride) as i32 + k_wi as i32 - padding as i32;

                                    if in_h >= 0 && in_h < h as i32 && in_w >= 0 && in_w < w as i32
                                    {
                                        g_w_co[[cii, k_hi, k_wi]] +=
                                            g_out * input4[[ni, cii, in_h as usize, in_w as usize]];
                                    }
                                }
                            }
                        }
                    }
                }
            }
        };

        #[cfg(feature = "rayon")]
        {
            use rayon::prelude::*;
            grad_weight
                .axis_iter_mut(ndarray::Axis(0))
                .into_par_iter()
                .enumerate()
                .for_each(kernel_grad_weight);
        }
        #[cfg(not(feature = "rayon"))]
        {
            grad_weight
                .axis_iter_mut(ndarray::Axis(0))
                .enumerate()
                .for_each(kernel_grad_weight);
        }

        Ok((grad_input.into_dyn().into(), grad_weight.into_dyn().into()))
    }

    fn max_pool2d(&self, input: &Tensor, kernel_size: usize, stride: usize) -> GPResult<Tensor> {
        let (n, c, _h, _w, oh, ow) = Self::max_pool2d_dims(input.shape(), kernel_size, stride)?;
        let input_view = input.try_view()?;
        let input4 = input_view
            .into_dimensionality::<ndarray::Ix4>()
            .map_err(|_| GPError::IncompatibleShapes {
                expected: vec![0, 0, 0, 0],
                found: input.shape().to_vec(),
                exp_len: 0,
                found_len: input.len(),
            })?;
        let mut output = ndarray::Array4::<f32>::zeros((n, c, oh, ow));

        let kernel = |(ni, mut out_batch): (usize, ndarray::ArrayViewMut3<f32>)| {
            for ci in 0..c {
                for hi in 0..oh {
                    for wi in 0..ow {
                        let mut max_val = f32::NEG_INFINITY;
                        for kh in 0..kernel_size {
                            for kw in 0..kernel_size {
                                let val = input4[[ni, ci, hi * stride + kh, wi * stride + kw]];
                                if val > max_val {
                                    max_val = val;
                                }
                            }
                        }
                        out_batch[[ci, hi, wi]] = max_val;
                    }
                }
            }
        };

        #[cfg(feature = "rayon")]
        {
            use rayon::prelude::*;
            output
                .axis_iter_mut(ndarray::Axis(0))
                .into_par_iter()
                .enumerate()
                .for_each(kernel);
        }
        #[cfg(not(feature = "rayon"))]
        {
            output
                .axis_iter_mut(ndarray::Axis(0))
                .enumerate()
                .for_each(kernel);
        }

        Ok(output.into_dyn().into())
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
        if grad_output.shape() != [n, c, expected_oh, expected_ow] {
            return Err(Self::shape_error(
                &[n, c, expected_oh, expected_ow],
                grad_output.shape(),
            ));
        }

        let input_view = input.try_view()?;
        let grad_out_view = grad_output.try_view()?;

        let input4 = input_view
            .into_dimensionality::<ndarray::Ix4>()
            .map_err(|_| GPError::IncompatibleShapes {
                expected: vec![0, 0, 0, 0],
                found: input.shape().to_vec(),
                exp_len: 0,
                found_len: input.len(),
            })?;
        let grad_out4 = grad_out_view
            .into_dimensionality::<ndarray::Ix4>()
            .map_err(|_| GPError::IncompatibleShapes {
                expected: vec![0, 0, 0, 0],
                found: grad_output.shape().to_vec(),
                exp_len: 0,
                found_len: grad_output.len(),
            })?;

        let oh = expected_oh;
        let ow = expected_ow;

        let mut grad_input = ndarray::Array4::<f32>::zeros((n, c, h, w));

        let kernel = |(ni, mut g_in_batch): (usize, ndarray::ArrayViewMut3<f32>)| {
            for ci in 0..c {
                for hi in 0..oh {
                    for wi in 0..ow {
                        let g_out = grad_out4[[ni, ci, hi, wi]];

                        let mut max_val = f32::NEG_INFINITY;
                        let mut max_h = 0;
                        let mut max_w = 0;

                        for kh in 0..kernel_size {
                            for kw in 0..kernel_size {
                                let cur_h = hi * stride + kh;
                                let cur_w = wi * stride + kw;
                                let val = input4[[ni, ci, cur_h, cur_w]];
                                if val > max_val {
                                    max_val = val;
                                    max_h = cur_h;
                                    max_w = cur_w;
                                }
                            }
                        }
                        g_in_batch[[ci, max_h, max_w]] += g_out;
                    }
                }
            }
        };

        #[cfg(feature = "rayon")]
        {
            use rayon::prelude::*;
            grad_input
                .axis_iter_mut(ndarray::Axis(0))
                .into_par_iter()
                .enumerate()
                .for_each(kernel);
        }
        #[cfg(not(feature = "rayon"))]
        {
            grad_input
                .axis_iter_mut(ndarray::Axis(0))
                .enumerate()
                .for_each(kernel);
        }

        Ok(grad_input.into_dyn().into())
    }

    fn add(&self, a: &Tensor, b: &Tensor) -> GPResult<Tensor> {
        Ok((a.try_view()?.to_owned() + &b.try_view()?)
            .into_dyn()
            .into())
    }

    fn add_into(&self, a: &Tensor, b: &Tensor, out: &mut Tensor) -> GPResult<()> {
        let a_view = a.try_view()?;
        let b_view = b.try_view()?;
        let mut out_view = out.try_view_mut()?;

        if a_view.shape() != b_view.shape() || a_view.shape() != out_view.shape() {
            return Err(GPError::IncompatibleShapes {
                expected: a.shape().to_vec(),
                found: b.shape().to_vec(),
                exp_len: a.len(),
                found_len: b.len(),
            });
        }

        Zip::from(&mut out_view)
            .and(&a_view)
            .and(&b_view)
            .for_each(|o, &av, &bv| {
                *o = av + bv;
            });

        Ok(())
    }

    fn mul(&self, a: &Tensor, b: &Tensor) -> GPResult<Tensor> {
        Ok((a.try_view()?.to_owned() * &b.try_view()?)
            .into_dyn()
            .into())
    }

    fn mul_into(&self, a: &Tensor, b: &Tensor, out: &mut Tensor) -> GPResult<()> {
        let a_view = a.try_view()?;
        let b_view = b.try_view()?;
        let mut out_view = out.try_view_mut()?;

        if a_view.shape() != b_view.shape() || a_view.shape() != out_view.shape() {
            return Err(GPError::IncompatibleShapes {
                expected: a.shape().to_vec(),
                found: b.shape().to_vec(),
                exp_len: a.len(),
                found_len: b.len(),
            });
        }

        Zip::from(&mut out_view)
            .and(&a_view)
            .and(&b_view)
            .for_each(|o, &av, &bv| {
                *o = av * bv;
            });

        Ok(())
    }

    fn mul_backward(
        &self,
        a: &Tensor,
        b: &Tensor,
        grad_output: &Tensor,
    ) -> GPResult<(Tensor, Tensor)> {
        let grad_a = self.mul(grad_output, b)?;
        let grad_b = self.mul(a, grad_output)?;
        Ok((grad_a, grad_b))
    }

    fn sigmoid(&self, x: &Tensor) -> GPResult<Tensor> {
        let mut res = x.clone();
        self.sigmoid_inplace(&mut res)?;
        Ok(res)
    }

    fn sigmoid_inplace(&self, x: &mut Tensor) -> GPResult<()> {
        let slice = x.as_slice_mut()?;
        for v in slice {
            *v = 1.0 / (1.0 + (-*v).exp());
        }
        Ok(())
    }

    fn relu(&self, x: &Tensor) -> GPResult<Tensor> {
        let mut res = x.clone();
        self.relu_inplace(&mut res)?;
        Ok(res)
    }

    fn relu_inplace(&self, x: &mut Tensor) -> GPResult<()> {
        let slice = x.as_slice_mut()?;
        for v in slice {
            if *v < 0.0 {
                *v = 0.0;
            }
        }
        Ok(())
    }

    fn tanh(&self, x: &Tensor) -> GPResult<Tensor> {
        Ok(x.mapv(|v: f32| v.tanh()))
    }

    fn tanh_inplace(&self, x: &mut Tensor) -> GPResult<()> {
        x.as_cpu_mut()?.map_inplace(|v| *v = v.tanh());
        Ok(())
    }

    fn add_relu(&self, a: &Tensor, b: &Tensor) -> GPResult<Tensor> {
        let mut res = a.try_view()?.to_owned() + &b.try_view()?;
        res.map_inplace(|v| {
            if *v < 0.0 {
                *v = 0.0
            }
        });
        Ok(res.into_dyn().into())
    }

    fn update_parameter(&self, param: &mut Tensor, grad: &Tensor, lr: f32) -> GPResult<()> {
        let mut p_view = param.try_view_mut()?;
        let g_view = grad.try_view()?;

        #[cfg(feature = "rayon")]
        Zip::from(&mut p_view).and(&g_view).par_for_each(|p, &g| {
            *p -= lr * g;
        });
        #[cfg(not(feature = "rayon"))]
        Zip::from(&mut p_view).and(&g_view).for_each(|p, &g| {
            *p -= lr * g;
        });
        Ok(())
    }

    fn relu_backward(&self, input: &Tensor, grad_output: &Tensor) -> GPResult<Tensor> {
        let mut grad = grad_output.try_view()?.to_owned();
        #[cfg(feature = "rayon")]
        Zip::from(grad.view_mut())
            .and(input.try_view()?)
            .par_for_each(|g, &i| {
                if i <= 0.0 {
                    *g = 0.0;
                }
            });
        #[cfg(not(feature = "rayon"))]
        Zip::from(grad.view_mut())
            .and(input.try_view()?)
            .for_each(|g, &i| {
                if i <= 0.0 {
                    *g = 0.0;
                }
            });
        Ok(grad.into_dyn().into())
    }

    fn sigmoid_backward(&self, output: &Tensor, grad_output: &Tensor) -> GPResult<Tensor> {
        let mut grad = grad_output.try_view()?.to_owned();
        #[cfg(feature = "rayon")]
        Zip::from(grad.view_mut())
            .and(output.try_view()?)
            .par_for_each(|g, &si| {
                *g *= si * (1.0 - si);
            });
        #[cfg(not(feature = "rayon"))]
        Zip::from(grad.view_mut())
            .and(output.try_view()?)
            .for_each(|g, &si| {
                *g *= si * (1.0 - si);
            });
        Ok(grad.into_dyn().into())
    }

    fn tanh_backward(&self, output: &Tensor, grad_output: &Tensor) -> GPResult<Tensor> {
        let mut grad = grad_output.try_view()?.to_owned();
        #[cfg(feature = "rayon")]
        Zip::from(grad.view_mut())
            .and(output.try_view()?)
            .par_for_each(|g, &y| {
                *g *= 1.0 - y * y;
            });
        #[cfg(not(feature = "rayon"))]
        Zip::from(grad.view_mut())
            .and(output.try_view()?)
            .for_each(|g, &y| {
                *g *= 1.0 - y * y;
            });
        Ok(grad.into_dyn().into())
    }

    fn reduce_sum(&self, input: &Tensor, axes: &[usize], keep_dims: bool) -> GPResult<Tensor> {
        let view = input.try_view()?;

        let mut curr = view.to_owned();
        let mut sorted_axes = axes.to_vec();
        sorted_axes.sort_by(|a, b| b.cmp(a));

        for &axis in &sorted_axes {
            curr = curr.sum_axis(ndarray::Axis(axis));
        }

        if keep_dims {
            let mut new_shape = view.shape().to_vec();
            for &axis in axes {
                new_shape[axis] = 1;
            }
            curr = curr
                .into_shape(new_shape)
                .map_err(|_e| GPError::IncompatibleShapes {
                    expected: vec![],
                    found: vec![],
                    exp_len: 0,
                    found_len: 0,
                })?;
        }

        Ok(curr.into_dyn().into())
    }
}
