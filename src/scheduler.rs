//! Learning rate schedulers.
//!
//! Schedulers adjust the learning rate of an optimizer during training.
//! Call `scheduler.step(&mut optimizer)` after each epoch.
//!
//! # Example
//!
//! ```rust
//! use gran_prix::optim::{Adam, Optimizer};
//! use gran_prix::scheduler::{StepLR, LRScheduler};
//!
//! let mut optimizer = Adam::new(0.01);
//! let mut scheduler = StepLR::new(0.01, 10, 0.5);
//!
//! // In training loop:
//! // optimizer.step(&mut params)?;
//! // scheduler.step_optimizer(&mut optimizer);
//! ```

use crate::optim::Optimizer;

/// Trait for learning rate schedulers.
pub trait LRScheduler {
    /// Advances the scheduler by one step and returns the new learning rate.
    fn step(&mut self) -> f32;

    /// Returns the current learning rate without advancing.
    fn current_lr(&self) -> f32;

    /// Advances the scheduler and applies the new LR to the optimizer.
    fn step_optimizer(&mut self, optimizer: &mut dyn Optimizer) {
        let lr = self.step();
        optimizer.set_lr(lr);
    }
}

/// Step decay: multiplies LR by `gamma` every `step_size` epochs.
///
/// ```rust
/// use gran_prix::scheduler::{StepLR, LRScheduler};
///
/// let mut sched = StepLR::new(0.1, 10, 0.5);
/// for _ in 0..10 { sched.step(); }
/// assert!((sched.current_lr() - 0.05).abs() < 1e-6);
/// ```
pub struct StepLR {
    #[allow(dead_code)]
    initial_lr: f32,
    step_size: usize,
    gamma: f32,
    current_epoch: usize,
    lr: f32,
}

impl StepLR {
    /// # Panics
    /// Panics if `step_size == 0` or `initial_lr <= 0.0`.
    pub fn new(initial_lr: f32, step_size: usize, gamma: f32) -> Self {
        assert!(step_size > 0, "step_size must be > 0");
        assert!(initial_lr > 0.0, "initial_lr must be > 0");
        Self { initial_lr, step_size, gamma, current_epoch: 0, lr: initial_lr }
    }
}

impl LRScheduler for StepLR {
    fn step(&mut self) -> f32 {
        self.current_epoch += 1;
        if self.current_epoch % self.step_size == 0 {
            self.lr *= self.gamma;
        }
        self.lr
    }

    fn current_lr(&self) -> f32 { self.lr }
}

/// Exponential decay: `lr = initial_lr * gamma^epoch`.
pub struct ExponentialLR {
    initial_lr: f32,
    gamma: f32,
    current_epoch: usize,
    lr: f32,
}

impl ExponentialLR {
    /// # Panics
    /// Panics if `initial_lr <= 0.0` or `gamma <= 0.0`.
    pub fn new(initial_lr: f32, gamma: f32) -> Self {
        assert!(initial_lr > 0.0, "initial_lr must be > 0");
        assert!(gamma > 0.0, "gamma must be > 0");
        Self { initial_lr, gamma, current_epoch: 0, lr: initial_lr }
    }
}

impl LRScheduler for ExponentialLR {
    fn step(&mut self) -> f32 {
        self.current_epoch += 1;
        self.lr = self.initial_lr * self.gamma.powi(self.current_epoch as i32);
        self.lr
    }

    fn current_lr(&self) -> f32 { self.lr }
}

/// Cosine annealing: oscillates LR between `initial_lr` and `min_lr` over `t_max` steps.
///
/// `lr = min_lr + 0.5 * (initial_lr - min_lr) * (1 + cos(π * epoch / t_max))`
pub struct CosineAnnealingLR {
    initial_lr: f32,
    min_lr: f32,
    t_max: usize,
    current_epoch: usize,
    lr: f32,
}

impl CosineAnnealingLR {
    /// # Panics
    /// Panics if `t_max == 0`, `initial_lr <= 0.0`, or `min_lr < 0.0`.
    pub fn new(initial_lr: f32, t_max: usize, min_lr: f32) -> Self {
        assert!(t_max > 0, "t_max must be > 0");
        assert!(initial_lr > 0.0, "initial_lr must be > 0");
        assert!(min_lr >= 0.0, "min_lr must be >= 0");
        Self { initial_lr, min_lr, t_max, current_epoch: 0, lr: initial_lr }
    }
}

impl LRScheduler for CosineAnnealingLR {
    fn step(&mut self) -> f32 {
        self.current_epoch += 1;
        let progress = self.current_epoch as f32 / self.t_max as f32;
        self.lr = self.min_lr
            + 0.5 * (self.initial_lr - self.min_lr)
            * (1.0 + (std::f32::consts::PI * progress).cos());
        self.lr
    }

    fn current_lr(&self) -> f32 { self.lr }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::optim::{SGD, Adam};

    #[test]
    fn test_step_lr() {
        let mut sched = StepLR::new(0.1, 5, 0.5);
        assert!((sched.current_lr() - 0.1).abs() < 1e-6);

        for _ in 0..4 { sched.step(); }
        assert!((sched.current_lr() - 0.1).abs() < 1e-6);

        sched.step(); // epoch 5 → decay
        assert!((sched.current_lr() - 0.05).abs() < 1e-6);

        for _ in 0..5 { sched.step(); }
        assert!((sched.current_lr() - 0.025).abs() < 1e-6);
    }

    #[test]
    fn test_exponential_lr() {
        let mut sched = ExponentialLR::new(1.0, 0.9);
        sched.step();
        assert!((sched.current_lr() - 0.9).abs() < 1e-6);
        sched.step();
        assert!((sched.current_lr() - 0.81).abs() < 1e-4);
    }

    #[test]
    fn test_cosine_annealing_lr() {
        let mut sched = CosineAnnealingLR::new(1.0, 100, 0.0);
        for _ in 0..50 { sched.step(); }
        assert!((sched.current_lr() - 0.5).abs() < 0.01);
        for _ in 0..50 { sched.step(); }
        assert!(sched.current_lr() < 0.01);
    }

    #[test]
    fn test_step_optimizer_integration() {
        let mut sgd = SGD::new(0.1, 0.0, 0.0);
        let mut sched = StepLR::new(0.1, 5, 0.5);

        for _ in 0..5 { sched.step_optimizer(&mut sgd); }
        assert!((sgd.get_lr() - 0.05).abs() < 1e-6);
    }

    #[test]
    fn test_step_optimizer_adam() {
        let mut adam = Adam::new(0.01);
        let mut sched = ExponentialLR::new(0.01, 0.95);
        sched.step_optimizer(&mut adam);
        assert!((adam.get_lr() - 0.0095).abs() < 1e-6);
    }
}
