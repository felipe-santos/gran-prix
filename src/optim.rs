use std::collections::HashMap;
use crate::{Tensor, GPResult};
use crate::graph::{Graph, Node};
#[cfg(feature = "rayon")]
use ndarray::Zip;

/// Advanced Gradient Descent Optimizers
pub trait Optimizer {
    fn step(&mut self, graph: &mut Graph) -> GPResult<()>;
}

pub struct SGD {
    pub lr: f32,
    pub momentum: f32,
    pub weight_decay: f32,
    velocities: HashMap<usize, Tensor>,
}

impl SGD {
    pub fn new(lr: f32, momentum: f32, weight_decay: f32) -> Self {
        Self {
            lr,
            momentum,
            weight_decay,
            velocities: HashMap::new(),
        }
    }
}

impl Optimizer for SGD {
    fn step(&mut self, graph: &mut Graph) -> GPResult<()> {
        for i in 0..graph.nodes().len() {
            let grad_opt = graph.get_gradient(crate::NodeId(i)).cloned();
            if let Some(mut grad) = grad_opt {
                if let Node::Param(param) = &mut graph.nodes_mut()[i] {
                    // Weight decay
                    if self.weight_decay != 0.0 {
                        // grad += weight_decay * param
                        let mut g_view = grad.try_view_mut()?;
                        let p_view = param.try_view()?;
                        
                        #[cfg(feature = "rayon")]
                        {
                            use rayon::prelude::*;
                            nd_zip_mut!(g_view, p_view, |g, p| { *g += self.weight_decay * p });
                        }
                        #[cfg(not(feature = "rayon"))]
                        {
                            ndarray::Zip::from(&mut g_view).and(&p_view).for_each(|g, &p| { *g += self.weight_decay * p });
                        }
                    }

                    // Momentum
                    let g_view = grad.try_view()?;
                    let v = self.velocities.entry(i).or_insert_with(|| Tensor::new_zeros(param.shape()));
                    let mut v_view = v.try_view_mut()?;
                    let mut p_view = param.try_view_mut()?;

                    if self.momentum != 0.0 {
                        #[cfg(not(feature = "rayon"))]
                        {
                            ndarray::Zip::from(&mut v_view).and(&g_view).for_each(|v, &g| {
                                *v = self.momentum * *v + g;
                            });
                            ndarray::Zip::from(&mut p_view).and(&v_view).for_each(|p, &v| {
                                *p -= self.lr * v;
                            });
                        }
                    } else {
                        // Plain SGD
                        #[cfg(not(feature = "rayon"))]
                        {
                            ndarray::Zip::from(&mut p_view).and(&g_view).for_each(|p, &g| {
                                *p -= self.lr * g;
                            });
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

pub struct Adam {
    pub lr: f32,
    pub beta1: f32,
    pub beta2: f32,
    pub epsilon: f32,
    pub weight_decay: f32,
    t: usize,
    m: HashMap<usize, Tensor>,
    v: HashMap<usize, Tensor>,
}

impl Adam {
    pub fn new(lr: f32) -> Self {
        Self {
            lr,
            beta1: 0.9,
            beta2: 0.999,
            epsilon: 1e-8,
            weight_decay: 0.0,
            t: 0,
            m: HashMap::new(),
            v: HashMap::new(),
        }
    }
}

impl Optimizer for Adam {
    fn step(&mut self, graph: &mut Graph) -> GPResult<()> {
        self.t += 1;
        
        let beta1_t = 1.0 - self.beta1.powi(self.t as i32);
        let beta2_t = 1.0 - self.beta2.powi(self.t as i32);
        
        for i in 0..graph.nodes().len() {
            let grad_opt = graph.get_gradient(crate::NodeId(i)).cloned();
            if let Some(mut grad) = grad_opt {
                if let Node::Param(param) = &mut graph.nodes_mut()[i] {
                    // Weight decay
                    if self.weight_decay != 0.0 {
                        let mut g_view = grad.try_view_mut()?;
                        let p_view = param.try_view()?;
                        
                        #[cfg(not(feature = "rayon"))]
                        {
                            ndarray::Zip::from(&mut g_view).and(&p_view).for_each(|g, &p| { *g += self.weight_decay * p });
                        }
                    }

                    let m = self.m.entry(i).or_insert_with(|| Tensor::new_zeros(param.shape()));
                    let v = self.v.entry(i).or_insert_with(|| Tensor::new_zeros(param.shape()));
                    
                    let mut m_view = m.try_view_mut()?;
                    let mut v_view = v.try_view_mut()?;
                    let mut p_view = param.try_view_mut()?;
                    let g_view = grad.try_view()?;

                    #[cfg(not(feature = "rayon"))]
                    {
                        ndarray::Zip::from(&mut p_view)
                            .and(&mut m_view)
                            .and(&mut v_view)
                            .and(&g_view)
                            .for_each(|p, m_val, v_val, &g| {
                                *m_val = self.beta1 * *m_val + (1.0 - self.beta1) * g;
                                *v_val = self.beta2 * *v_val + (1.0 - self.beta2) * g * g;
                                
                                let m_hat = *m_val / beta1_t;
                                let v_hat = *v_val / beta2_t;
                                
                                *p -= self.lr * m_hat / (v_hat.sqrt() + self.epsilon);
                            });
                    }
                }
            }
        }
        Ok(())
    }
}
