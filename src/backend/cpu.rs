use crate::backend::Backend;
use crate::Tensor;
use anyhow::Result;
use ndarray::Zip;

#[derive(Debug)]
pub struct CPUBackend;

impl Backend for CPUBackend {
    #[tracing::instrument(skip(self, a, b), name = "kernel_matmul")]
    fn matmul_t(&self, a: &Tensor, b: &Tensor, trans_a: bool, trans_b: bool) -> Result<Tensor> {
        // Convert dynamic dims to 2D for dot product
        let a2 = a.view().into_dimensionality::<ndarray::Ix2>()?;
        let b2 = b.view().into_dimensionality::<ndarray::Ix2>()?;
        
        let lhs = if trans_a { a2.t() } else { a2 };
        let rhs = if trans_b { b2.t() } else { b2 };
        
        let res = lhs.dot(&rhs);
        Ok(res.into_dyn())
    }

    fn conv2d(&self, input: &Tensor, weight: &Tensor, stride: usize, padding: usize) -> Result<Tensor> {
        let input4 = input.view().into_dimensionality::<ndarray::Ix4>()?;
        let weight4 = weight.view().into_dimensionality::<ndarray::Ix4>()?;
        
        let (n, ci, h, w) = input4.dim();
        let (co, _ci, kh, kw) = weight4.dim();
        
        let oh = (h + 2 * padding - kh) / stride + 1;
        let ow = (w + 2 * padding - kw) / stride + 1;
        
        let mut output = ndarray::Array4::<f32>::zeros((n, co, oh, ow));
        
        use rayon::prelude::*;

        // Parallelize over Batch dimension
        output.axis_iter_mut(ndarray::Axis(0))
            .into_par_iter()
            .enumerate()
            .for_each(|(ni, mut out_batch)| {
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
            });
        
        Ok(output.into_dyn())
    }

    fn conv2d_backward(&self, input: &Tensor, weight: &Tensor, grad_output: &Tensor, stride: usize, padding: usize) -> Result<(Tensor, Tensor)> {
        let input4 = input.view().into_dimensionality::<ndarray::Ix4>()?;
        let weight4 = weight.view().into_dimensionality::<ndarray::Ix4>()?;
        let grad_out4 = grad_output.view().into_dimensionality::<ndarray::Ix4>()?;
        
        let (n, ci, h, w) = input4.dim();
        let (co, _ci, kh, kw) = weight4.dim();
        let (_n, _co, oh, ow) = grad_out4.dim();
        
        let mut grad_input = ndarray::Array4::<f32>::zeros((n, ci, h, w));
        let mut grad_weight = ndarray::Array4::<f32>::zeros((co, ci, kh, kw));
        
        use rayon::prelude::*;
        
        // 1. Gradient for Input: Parallelize over Batch dimension (no write collisions)
        grad_input.axis_iter_mut(ndarray::Axis(0))
            .into_par_iter()
            .enumerate()
            .for_each(|(ni, mut g_in_batch)| {
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
            });

        // 2. Gradient for Weight: Parallelize over Output Channels (each thread owns a slice of weight grad)
        grad_weight.axis_iter_mut(ndarray::Axis(0))
            .into_par_iter()
            .enumerate()
            .for_each(|(coi, mut g_w_co)| {
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
            });
        
        Ok((grad_input.into_dyn(), grad_weight.into_dyn()))
    }

    fn max_pool2d(&self, input: &Tensor, kernel_size: usize, stride: usize) -> Result<Tensor> {
        let input4 = input.view().into_dimensionality::<ndarray::Ix4>()?;
        let (n, c, h, w) = input4.dim();
        
        let oh = (h - kernel_size) / stride + 1;
        let ow = (w - kernel_size) / stride + 1;
        
        let mut output = ndarray::Array4::<f32>::zeros((n, c, oh, ow));
        
        use rayon::prelude::*;
        
        output.axis_iter_mut(ndarray::Axis(0))
            .into_par_iter()
            .enumerate()
            .for_each(|(ni, mut out_batch)| {
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
            });
        
        Ok(output.into_dyn())
    }

    fn max_pool2d_backward(&self, input: &Tensor, grad_output: &Tensor, kernel_size: usize, stride: usize) -> Result<Tensor> {
        let input4 = input.view().into_dimensionality::<ndarray::Ix4>()?;
        let grad_out4 = grad_output.view().into_dimensionality::<ndarray::Ix4>()?;
        
        let (n, c, h, w) = input4.dim();
        let (_n, _c, oh, ow) = grad_out4.dim();
        
        let mut grad_input = ndarray::Array4::<f32>::zeros((n, c, h, w));
        
        use rayon::prelude::*;
        
        grad_input.axis_iter_mut(ndarray::Axis(0))
            .into_par_iter()
            .enumerate()
            .for_each(|(ni, mut g_in_batch)| {
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
            });
        
        Ok(grad_input.into_dyn())
    }

    fn add(&self, a: &Tensor, b: &Tensor) -> Result<Tensor> {
        Ok(a + b)
    }

    fn sigmoid(&self, x: &Tensor) -> Result<Tensor> {
        let mut res = x.clone();
        Zip::from(&mut res).par_for_each(|v| {
            *v = 1.0 / (1.0 + (-*v).exp());
        });
        Ok(res)
    }

    fn relu(&self, x: &Tensor) -> Result<Tensor> {
        let mut res = x.clone();
        Zip::from(&mut res).par_for_each(|v| {
            if *v < 0.0 { *v = 0.0; }
        });
        Ok(res)
    }

    #[tracing::instrument(skip(self, a, b), name = "kernel_add_relu_fused")]
    fn add_relu(&self, a: &Tensor, b: &Tensor) -> Result<Tensor> {
        let mut res = a.clone();
        Zip::from(&mut res).and(b).par_for_each(|r, &bi| {
            let sum = *r + bi;
            *r = if sum < 0.0 { 0.0 } else { sum };
        });
        Ok(res)
    }
}
