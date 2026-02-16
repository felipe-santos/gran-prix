use crate::backend::Backend;
use crate::{Tensor, GPResult, GPError};
use ndarray::Zip;

#[derive(Debug)]
pub struct CPUBackend;

impl Backend for CPUBackend {
    fn matmul_t(&self, a: &Tensor, b: &Tensor, trans_a: bool, trans_b: bool) -> GPResult<Tensor> {
        let (m, _) = if trans_a { (a.shape()[1], a.shape()[0]) } else { (a.shape()[0], a.shape()[1]) };
        let (_, n) = if trans_b { (b.shape()[1], b.shape()[0]) } else { (b.shape()[0], b.shape()[1]) };
        let mut res = Tensor::new_zeros(&[m, n]);
        self.matmul_into(a, b, trans_a, trans_b, &mut res)?;
        Ok(res)
    }

    fn matmul_into(&self, a: &Tensor, b: &Tensor, trans_a: bool, trans_b: bool, out: &mut Tensor) -> GPResult<()> {
        let a_shape = a.shape();
        let b_shape = b.shape();
        let out_shape = out.shape();

        if a_shape.len() < 2 || b_shape.len() < 2 {
            return Err(GPError::IncompatibleShapes { 
                expected: vec![0, 0], 
                found: a_shape.to_vec(),
                exp_len: 0,
                found_len: a.len(),
            });
        }

        let l_rows = if trans_a { a_shape[1] } else { a_shape[0] };
        let l_cols = if trans_a { a_shape[0] } else { a_shape[1] };
        let r_rows = if trans_b { b_shape[1] } else { b_shape[0] };
        let r_cols = if trans_b { b_shape[0] } else { b_shape[1] };

        if l_cols != r_rows {
            return Err(GPError::IncompatibleShapes { 
                expected: vec![l_rows, l_cols], 
                found: vec![r_rows, r_cols],
                exp_len: l_cols,
                found_len: r_rows,
            });
        }
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
                    let a_idx = if trans_a { l * a_shape[1] + i } else { i * a_shape[1] + l };
                    let b_idx = if trans_b { j * b_shape[1] + l } else { l * b_shape[1] + j };
                    
                    // Boundary check via slice indexing is safe in Rust
                    sum += a_slice[a_idx] * b_slice[b_idx];
                }
                out_slice[i_n + j] = sum;
            }
        }
        Ok(())
    }

    fn conv2d(&self, input: &Tensor, weight: &Tensor, stride: usize, padding: usize) -> GPResult<Tensor> {
        let input_view = input.try_view()?;
        let weight_view = weight.try_view()?;

        let input4 = input_view.into_dimensionality::<ndarray::Ix4>()
            .map_err(|_| GPError::IncompatibleShapes { 
                expected: vec![0,0,0,0], 
                found: input.shape().to_vec(),
                exp_len: 0,
                found_len: input.len(),
            })?;
        let weight4 = weight_view.into_dimensionality::<ndarray::Ix4>()
            .map_err(|_| GPError::IncompatibleShapes { 
                expected: vec![0,0,0,0], 
                found: weight.shape().to_vec(),
                exp_len: 0,
                found_len: weight.len(),
            })?;
        
        let (n, ci, h, w) = input4.dim();
        let (co, _ci, kh, kw) = weight4.dim();
        
        let oh = (h + 2 * padding - kh) / stride + 1;
        let ow = (w + 2 * padding - kw) / stride + 1;
        
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
                                    
                                    if in_h >= 0 && in_h < h as i32 && in_w >= 0 && in_w < w as i32 {
                                        sum += input4[[ni, cii, in_h as usize, in_w as usize]] * 
                                                weight4[[coi, cii, k_hi, k_wi]];
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
            output.axis_iter_mut(ndarray::Axis(0))
                .into_par_iter()
                .enumerate()
                .for_each(kernel);
        }

        #[cfg(not(feature = "rayon"))]
        {
            output.axis_iter_mut(ndarray::Axis(0))
                .enumerate()
                .for_each(kernel);
        }
        
        Ok(output.into_dyn().into())
    }

    fn conv2d_backward(&self, input: &Tensor, weight: &Tensor, grad_output: &Tensor, stride: usize, padding: usize) -> GPResult<(Tensor, Tensor)> {
        let input_view = input.try_view()?;
        let weight_view = weight.try_view()?;
        let grad_out_view = grad_output.try_view()?;

        let input4 = input_view.into_dimensionality::<ndarray::Ix4>()
            .map_err(|_| GPError::IncompatibleShapes { 
                expected: vec![0,0,0,0], 
                found: input.shape().to_vec(),
                exp_len: 0,
                found_len: input.len()
            })?;
        let weight4 = weight_view.into_dimensionality::<ndarray::Ix4>()
            .map_err(|_| GPError::IncompatibleShapes { 
                expected: vec![0,0,0,0], 
                found: weight.shape().to_vec(),
                exp_len: 0,
                found_len: weight.len()
            })?;
        let grad_out4 = grad_out_view.into_dimensionality::<ndarray::Ix4>()
            .map_err(|_| GPError::IncompatibleShapes { 
                expected: vec![0,0,0,0], 
                found: grad_output.shape().to_vec(),
                exp_len: 0,
                found_len: grad_output.len()
            })?;
        
        let (n, ci, h, w) = input4.dim();
        let (co, _ci, kh, kw) = weight4.dim();
        let (_n, _co, oh, ow) = grad_out4.dim();
        
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
                                    
                                    if in_h >= 0 && in_h < h as i32 && in_w >= 0 && in_w < w as i32 {
                                        g_in_batch[[cii, in_h as usize, in_w as usize]] += g_out * weight4[[coi, cii, k_hi, k_wi]];
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
            grad_input.axis_iter_mut(ndarray::Axis(0))
                .into_par_iter()
                .enumerate()
                .for_each(kernel_grad_input);
        }
        #[cfg(not(feature = "rayon"))]
        {
            grad_input.axis_iter_mut(ndarray::Axis(0))
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
                                    
                                    if in_h >= 0 && in_h < h as i32 && in_w >= 0 && in_w < w as i32 {
                                        g_w_co[[cii, k_hi, k_wi]] += g_out * input4[[ni, cii, in_h as usize, in_w as usize]];
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
            grad_weight.axis_iter_mut(ndarray::Axis(0))
                .into_par_iter()
                .enumerate()
                .for_each(kernel_grad_weight);
        }
        #[cfg(not(feature = "rayon"))]
        {
            grad_weight.axis_iter_mut(ndarray::Axis(0))
                .enumerate()
                .for_each(kernel_grad_weight);
        }
        
        Ok((grad_input.into_dyn().into(), grad_weight.into_dyn().into()))
    }

    fn max_pool2d(&self, input: &Tensor, kernel_size: usize, stride: usize) -> GPResult<Tensor> {
        let input_view = input.try_view()?;
        let input4 = input_view.into_dimensionality::<ndarray::Ix4>()
            .map_err(|_| GPError::IncompatibleShapes { 
                expected: vec![0,0,0,0], 
                found: input.shape().to_vec(),
                exp_len: 0,
                found_len: input.len(),
            })?;
        let (n, c, h, w) = input4.dim();
        
        let oh = (h - kernel_size) / stride + 1;
        let ow = (w - kernel_size) / stride + 1;
        
        let mut output = ndarray::Array4::<f32>::zeros((n, c, oh, ow));
        
        let kernel = |(ni, mut out_batch): (usize, ndarray::ArrayViewMut3<f32>)| {
            for ci in 0..c {
                for hi in 0..oh {
                    for wi in 0..ow {
                        let mut max_val = f32::NEG_INFINITY;
                        for kh in 0..kernel_size {
                            for kw in 0..kernel_size {
                                let val = input4[[ni, ci, hi * stride + kh, wi * stride + kw]];
                                if val > max_val { max_val = val; }
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
            output.axis_iter_mut(ndarray::Axis(0))
                .into_par_iter()
                .enumerate()
                .for_each(kernel);
        }
        #[cfg(not(feature = "rayon"))]
        {
            output.axis_iter_mut(ndarray::Axis(0))
                .enumerate()
                .for_each(kernel);
        }
        
        Ok(output.into_dyn().into())
    }

    fn max_pool2d_backward(&self, input: &Tensor, grad_output: &Tensor, kernel_size: usize, stride: usize) -> GPResult<Tensor> {
        let input_view = input.try_view()?;
        let grad_out_view = grad_output.try_view()?;

        let input4 = input_view.into_dimensionality::<ndarray::Ix4>()
            .map_err(|_| GPError::IncompatibleShapes { 
                expected: vec![0,0,0,0], 
                found: input.shape().to_vec(),
                exp_len: 0,
                found_len: input.len()
            })?;
        let grad_out4 = grad_out_view.into_dimensionality::<ndarray::Ix4>()
            .map_err(|_| GPError::IncompatibleShapes { 
                expected: vec![0,0,0,0], 
                found: grad_output.shape().to_vec(),
                exp_len: 0,
                found_len: grad_output.len()
            })?;
        
        let (n, c, h, w) = input4.dim();
        let (_n, _c, oh, ow) = grad_out4.dim();
        
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
            grad_input.axis_iter_mut(ndarray::Axis(0))
                .into_par_iter()
                .enumerate()
                .for_each(kernel);
        }
        #[cfg(not(feature = "rayon"))]
        {
            grad_input.axis_iter_mut(ndarray::Axis(0))
                .enumerate()
                .for_each(kernel);
        }
        
        Ok(grad_input.into_dyn().into())
    }

    fn add(&self, a: &Tensor, b: &Tensor) -> GPResult<Tensor> {
        Ok((a.try_view()?.to_owned() + &b.try_view()?).into_dyn().into())
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

        Zip::from(&mut out_view).and(&a_view).and(&b_view).for_each(|o, &av, &bv| {
            *o = av + bv;
        });

        Ok(())
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
            if *v < 0.0 { *v = 0.0; }
        }
        Ok(())
    }

    fn add_relu(&self, a: &Tensor, b: &Tensor) -> GPResult<Tensor> {
        let mut res = a.try_view()?.to_owned() + &b.try_view()?;
        res.map_inplace(|v| if *v < 0.0 { *v = 0.0 });
        Ok(res.into_dyn().into())
    }

    fn update_parameter(&self, param: &mut Tensor, grad: &Tensor, learning_rate: f32) -> GPResult<()> {
        *param -= &(grad * learning_rate);
        Ok(())
    }

    fn relu_backward(&self, input: &Tensor, grad_output: &Tensor) -> GPResult<Tensor> {
        let mut grad = grad_output.try_view()?.to_owned();
        #[cfg(feature = "rayon")]
        Zip::from(grad.view_mut()).and(input.try_view()?).par_for_each(|g, &i| {
            if i <= 0.0 { *g = 0.0; }
        });
        #[cfg(not(feature = "rayon"))]
        Zip::from(grad.view_mut()).and(input.try_view()?).for_each(|g, &i| {
            if i <= 0.0 { *g = 0.0; }
        });
        Ok(grad.into_dyn().into())
    }

    fn sigmoid_backward(&self, output: &Tensor, grad_output: &Tensor) -> GPResult<Tensor> {
        let mut grad = grad_output.try_view()?.to_owned();
        #[cfg(feature = "rayon")]
        Zip::from(grad.view_mut()).and(output.try_view()?).par_for_each(|g, &si| {
            *g *= si * (1.0 - si);
        });
        #[cfg(not(feature = "rayon"))]
        Zip::from(grad.view_mut()).and(output.try_view()?).for_each(|g, &si| {
            *g *= si * (1.0 - si);
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
             curr = curr.into_shape(new_shape)
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
