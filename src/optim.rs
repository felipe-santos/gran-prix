//! Gradient descent optimizers.
//!
//! Optimizers update parameter tensors based on accumulated gradients.
//! They work directly with [`ParamStore`], without knowledge of the
//! computation graph topology.
//!
//! # Design
//!
//! The [`Optimizer`] trait takes a mutable [`ParamStore`] reference,
//! not a `Graph`. This decouples parameter updates from graph structure.
//!
//! For backward compatibility, there is also a `step_graph` method that
//! takes `&mut Graph` and delegates to the param store within.

use std::collections::HashMap;
use crate::{Tensor, GPResult};
use crate::params::{ParamStore, ParamId};
use crate::graph::Graph;

/// Trait for parameter optimizers.
///
/// Implementations should iterate over trainable parameters in the store,
/// apply their update rule, and clear gradients when done.
pub trait Optimizer {
    /// Updates all trainable parameters in the store using accumulated gradients.
    fn step(&mut self, params: &mut ParamStore) -> GPResult<()>;

    /// Convenience: updates parameters within a Graph's embedded ParamStore.
    fn step_graph(&mut self, graph: &mut Graph) -> GPResult<()> {
        self.step(graph.params_mut())
    }
}

/// Stochastic Gradient Descent with optional momentum and weight decay.
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
    fn step(&mut self, params: &mut ParamStore) -> GPResult<()> {
        for i in 0..params.len() {
            let id = ParamId(i);
            if params.is_frozen(id) {
                continue;
            }
            // Clone the gradient to release the borrow on params
            let grad = match params.gradient(id) {
                Some(g) => g.clone(),
                None => continue,
            };

            let tensor = params.tensor_mut(id);

            // Apply weight decay: grad += weight_decay * param
            if self.weight_decay != 0.0 {
                let p_slice = tensor.as_slice()?;
                let mut grad_data: Vec<f32> = grad.as_slice()?.to_vec();
                for (g, &p) in grad_data.iter_mut().zip(p_slice.iter()) {
                    *g += self.weight_decay * p;
                }
                // Rebuild grad tensor with decay applied
                let grad_with_decay = Tensor::from_shape_vec(grad.shape(), grad_data)?;

                let v = self.velocities.entry(i)
                    .or_insert_with(|| Tensor::new_zeros(tensor.shape()));

                if self.momentum != 0.0 {
                    let v_slice = v.as_slice_mut()?;
                    let g_slice = grad_with_decay.as_slice()?;
                    let p_slice = tensor.as_slice_mut()?;
                    for j in 0..p_slice.len() {
                        v_slice[j] = self.momentum * v_slice[j] + g_slice[j];
                        p_slice[j] -= self.lr * v_slice[j];
                    }
                } else {
                    let g_slice = grad_with_decay.as_slice()?;
                    let p_slice = tensor.as_slice_mut()?;
                    for j in 0..p_slice.len() {
                        p_slice[j] -= self.lr * g_slice[j];
                    }
                }
            } else {
                // No weight decay — simpler path
                let v = self.velocities.entry(i)
                    .or_insert_with(|| Tensor::new_zeros(tensor.shape()));

                if self.momentum != 0.0 {
                    let v_slice = v.as_slice_mut()?;
                    let g_slice = grad.as_slice()?;
                    let p_slice = tensor.as_slice_mut()?;
                    for j in 0..p_slice.len() {
                        v_slice[j] = self.momentum * v_slice[j] + g_slice[j];
                        p_slice[j] -= self.lr * v_slice[j];
                    }
                } else {
                    let g_slice = grad.as_slice()?;
                    let p_slice = tensor.as_slice_mut()?;
                    for j in 0..p_slice.len() {
                        p_slice[j] -= self.lr * g_slice[j];
                    }
                }
            }
        }
        Ok(())
    }
}

/// Adam optimizer (Adaptive Moment Estimation).
///
/// Maintains per-parameter first moment (m) and second moment (v) estimates
/// with bias correction.
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
    fn step(&mut self, params: &mut ParamStore) -> GPResult<()> {
        self.t += 1;

        let beta1_t = 1.0 - self.beta1.powi(self.t as i32);
        let beta2_t = 1.0 - self.beta2.powi(self.t as i32);

        for i in 0..params.len() {
            let id = ParamId(i);
            if params.is_frozen(id) {
                continue;
            }
            let grad = match params.gradient(id) {
                Some(g) => g.clone(),
                None => continue,
            };

            let tensor = params.tensor_mut(id);

            let m = self.m.entry(i)
                .or_insert_with(|| Tensor::new_zeros(tensor.shape()));
            let v = self.v.entry(i)
                .or_insert_with(|| Tensor::new_zeros(tensor.shape()));

            let m_slice = m.as_slice_mut()?;
            let v_slice = v.as_slice_mut()?;
            let p_slice = tensor.as_slice_mut()?;
            let g_slice = grad.as_slice()?;

            for j in 0..p_slice.len() {
                let mut g = g_slice[j];

                // Weight decay
                if self.weight_decay != 0.0 {
                    g += self.weight_decay * p_slice[j];
                }

                // Update moments
                m_slice[j] = self.beta1 * m_slice[j] + (1.0 - self.beta1) * g;
                v_slice[j] = self.beta2 * v_slice[j] + (1.0 - self.beta2) * g * g;

                // Bias-corrected estimates
                let m_hat = m_slice[j] / beta1_t;
                let v_hat = v_slice[j] / beta2_t;

                // Update parameter
                p_slice[j] -= self.lr * m_hat / (v_hat.sqrt() + self.epsilon);
            }
        }
        Ok(())
    }
}
