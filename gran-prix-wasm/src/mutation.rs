//! Mutation Strategies and RNG for Neuroevolution
//!
//! This module provides mutation strategies for evolving neural network weights
//! and a fast PRNG optimized for WASM environments.
//!
//! # Mutation Strategies
//!
//! - **Additive**: Add random noise to weights
//! - **Multiplicative**: Scale weights by random factor
//! - **Reset**: Completely randomize weights
//!
//! # Performance
//!
//! `XorShift` PRNG is chosen for:
//! - Fast generation (no system calls)
//! - Deterministic (reproducible evolution)
//! - Small state (4 bytes)
//! - Good distribution for ML applications

use wasm_bindgen::prelude::*;

/// Mutation strategy for neural network weight evolution
///
/// # Examples
///
/// ```
/// use gran_prix_wasm::MutationStrategy;
///
/// let strategy = MutationStrategy::Additive;
/// ```
#[wasm_bindgen]
#[derive(Copy, Clone, Debug)]
pub enum MutationStrategy {
    /// Add random noise: `weight + random(-scale, scale)`
    Additive,
    /// Scale by random factor: `weight * (1.0 + random(-scale, scale))`
    Multiplicative,
    /// Reset to random value: `weight = random(-scale, scale)`
    Reset,
}

impl MutationStrategy {
    /// Apply mutation to a single weight value
    ///
    /// # Arguments
    ///
    /// * `weight` - Current weight value
    /// * `scale` - Mutation magnitude
    /// * `rng` - Random number generator
    ///
    /// # Returns
    ///
    /// Mutated weight value
    #[inline]
    pub(crate) fn apply(&self, weight: f32, scale: f32, rng: &mut XorShift) -> f32 {
        match self {
            MutationStrategy::Additive => weight + rng.range(-scale, scale),
            MutationStrategy::Multiplicative => weight * (1.0 + rng.range(-scale, scale)),
            MutationStrategy::Reset => rng.range(-scale, scale),
        }
    }
}

/// Fast pseudo-random number generator for evolution
///
/// XorShift is a simple, fast PRNG suitable for WebAssembly environments.
/// It has a period of 2^32 - 1 and good distribution properties for ML.
///
/// # Design Rationale
///
/// - **No dependencies**: Self-contained, no external RNG crates
/// - **Deterministic**: Same seed produces same sequence (reproducibility)
/// - **Fast**: 3 XOR + 3 shift operations only
/// - **WASM-friendly**: No system calls, pure arithmetic
///
/// # Thread Safety
///
/// `XorShift` is `!Send + !Sync` by design (uses mutable state).
/// Each mutation should have its own instance.
pub(crate) struct XorShift {
    state: u32,
}

impl XorShift {
    /// Create a new XorShift RNG with given seed
    ///
    /// # Arguments
    ///
    /// * `seed` - Initial state (0 is replaced with 0xDEADBEEF)
    ///
    /// # Returns
    ///
    /// New RNG instance
    ///
    /// # Notes
    ///
    /// A seed of 0 would cause the generator to output all zeros,
    /// so we replace it with a non-zero constant.
    pub(crate) fn new(seed: u32) -> Self {
        Self {
            state: if seed == 0 { 0xDEADBEEF } else { seed },
        }
    }

    /// Generate next random f32 in range [0.0, 1.0)
    ///
    /// # Algorithm
    ///
    /// Uses XorShift32 algorithm: https://en.wikipedia.org/wiki/Xorshift
    ///
    /// ```text
    /// x ^= x << 13
    /// x ^= x >> 17
    /// x ^= x << 5
    /// ```
    ///
    /// # Returns
    ///
    /// Random float in [0.0, 1.0)
    #[inline]
    pub(crate) fn next_f32(&mut self) -> f32 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.state = x;
        // Normalize to [0.0, 1.0) range
        (x as f32) / (u32::MAX as f32)
    }

    /// Generate random f32 in range [min, max)
    ///
    /// # Arguments
    ///
    /// * `min` - Minimum value (inclusive)
    /// * `max` - Maximum value (exclusive)
    ///
    /// # Returns
    ///
    /// Random float in [min, max)
    ///
    /// # Examples
    ///
    /// ```
    /// let mut rng = XorShift::new(42);
    /// let value = rng.range(-1.0, 1.0); // Random in [-1.0, 1.0)
    /// ```
    #[inline]
    pub(crate) fn range(&mut self, min: f32, max: f32) -> f32 {
        min + (self.next_f32() * (max - min))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_xorshift_deterministic() {
        let mut rng1 = XorShift::new(42);
        let mut rng2 = XorShift::new(42);

        for _ in 0..100 {
            assert_eq!(rng1.next_f32(), rng2.next_f32());
        }
    }

    #[test]
    fn test_xorshift_range() {
        let mut rng = XorShift::new(123);

        for _ in 0..1000 {
            let val = rng.range(-10.0, 10.0);
            assert!(val >= -10.0 && val < 10.0);
        }
    }

    #[test]
    fn test_xorshift_zero_seed() {
        let mut rng = XorShift::new(0);
        let val = rng.next_f32();
        assert!(val > 0.0); // Should not be stuck at zero
    }

    #[test]
    fn test_mutation_additive() {
        let mut rng = XorShift::new(42);
        let weight = 1.0;
        let mutated = MutationStrategy::Additive.apply(weight, 0.5, &mut rng);
        // Should be within [0.5, 1.5]
        assert!(mutated >= 0.5 && mutated <= 1.5);
    }

    #[test]
    fn test_mutation_multiplicative() {
        let mut rng = XorShift::new(42);
        let weight = 1.0;
        let mutated = MutationStrategy::Multiplicative.apply(weight, 0.5, &mut rng);
        // Should be within [0.5, 1.5]
        assert!(mutated >= 0.5 && mutated <= 1.5);
    }

    #[test]
    fn test_mutation_reset() {
        let mut rng = XorShift::new(42);
        let weight = 1.0;
        let mutated = MutationStrategy::Reset.apply(weight, 0.5, &mut rng);
        // Should ignore original weight
        assert!(mutated >= -0.5 && mutated <= 0.5);
    }
}
