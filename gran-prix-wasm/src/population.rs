//! Population Management for Neuroevolution
//!
//! This module implements evolutionary algorithms for neural network populations.
//! It handles selection, elitism, mutation, and fitness-based evolution.
//!
//! # Evolution Algorithm
//!
//! 1. **Selection**: Choose best individual based on fitness
//! 2. **Elitism**: Preserve best individual unchanged
//! 3. **Offspring**: Create mutated copies of best individual
//! 4. **Iteration**: Repeat for each generation
//!
//! # Performance
//!
//! - Deterministic RNG for reproducible evolution
//! - Single-best selection (simple and effective for demos)
//! - No crossover (mutation-only evolution)

use wasm_bindgen::prelude::*;

use crate::brain::NeuralBrain;
use crate::mutation::{MutationStrategy, XorShift};
use std::cell::RefCell;

/// Population of neural network agents
///
/// Manages a collection of `NeuralBrain` instances and provides evolutionary
/// operators (selection, mutation, elitism).
///
/// # Design Rationale
///
/// - **Elitism**: Best agent always survives (prevents regression)
/// - **Asexual reproduction**: Mutation-only (no crossover)
/// - **Deterministic**: Same fitness sequence produces same evolution
///
/// # Examples
///
/// ```no_run
/// use gran_prix_wasm::{Population, MutationStrategy};
///
/// let mut pop = Population::new(50, 4, vec![8], 2).unwrap();
/// let fitness = vec![1.0; 50];
/// pop.evolve(&fitness, 0.15, 0.5, MutationStrategy::Additive).unwrap();
/// ```
#[wasm_bindgen]
pub struct Population {
    /// Neural network agents in the population
    brains: Vec<NeuralBrain>,
    /// Current generation number
    generation: u32,
    /// Random number generator for mutations
    rng: XorShift,
    /// Global convolution kernel shared by all brains
    global_kernel: Vec<f32>,
    /// Network architecture parameters
    num_inputs: usize,
    hidden_layers: Vec<usize>,
    num_outputs: usize,
    /// Pre-allocated output buffer to avoid per-frame allocations
    output_buffer: RefCell<Vec<f32>>,
}

#[wasm_bindgen]
impl Population {
    /// Create a new population
    ///
    /// # Arguments
    ///
    /// * `size` - Number of agents in population
    /// * `num_inputs` - Input layer size for each brain
    /// * `hidden_size` - Hidden layer size for each brain
    /// * `num_outputs` - Output layer size for each brain
    ///
    /// # Returns
    ///
    /// New population or error if size is 0 or brain construction fails
    ///
    /// # Weight Initialization
    ///
    /// Each brain is initialized with a unique `seed_offset` based on its index.
    /// This ensures diversity in initial population.
    #[wasm_bindgen(constructor)]
    pub fn new(
        size: usize,
        num_inputs: usize,
        hidden_layers: Vec<usize>,
        num_outputs: usize,
    ) -> Result<Population, JsValue> {
        if size == 0 {
            return Err(JsValue::from_str("Population size cannot be 0"));
        }

        let mut brains = Vec::with_capacity(size);
        for i in 0..size {
            // Create brain with varied weights based on index
            let brain = NeuralBrain::new(i, num_inputs, hidden_layers.clone(), num_outputs)?;
            brains.push(brain);
        }

        let pop = Population {
            brains,
            generation: 1,
            rng: XorShift::new(12345), // Fixed seed for reproducibility
            global_kernel: vec![0.0, 1.0, 0.0], // Identity kernel
            num_inputs,
            hidden_layers,
            num_outputs,
            output_buffer: RefCell::new(vec![0.0; size * num_outputs]),
        };

        Ok(pop)
    }

    /// Get number of agents in population
    ///
    /// # Returns
    ///
    /// Population size
    pub fn count(&self) -> usize {
        self.brains.len()
    }

    /// Compute forward pass for all agents
    /// Compute forward pass for all agents
    ///
    /// # Arguments
    ///
    /// * inputs - Flattened input array of shape (population_size * num_inputs)
    ///
    /// # Returns
    ///
    /// Flattened output array of shape (population_size * num_outputs)
    ///
    /// # Performance
    ///
    /// This is called every frame for all agents. Optimized for speed.
    pub fn compute_all(&self, inputs: &[f32]) -> Result<Vec<f32>, JsValue> {
        let expected_len = self.brains.len() * self.num_inputs;
        if inputs.len() != expected_len {
            return Err(JsValue::from_str(&format!(
                "Input array length mismatch. Expected {}, got {}",
                expected_len,
                inputs.len()
            )));
        }

        let mut outputs = self.output_buffer.borrow_mut();
        
        // Ensure buffer size is correct (in case of dynamic resizing in future)
        if outputs.len() != self.brains.len() * self.num_outputs {
            *outputs = vec![0.0; self.brains.len() * self.num_outputs];
        }

        for (i, brain) in self.brains.iter().enumerate() {
            let in_offset = i * self.num_inputs;
            let out_offset = i * self.num_outputs;
            
            // Note: compute() still returns a Vec<f32> currently. 
            // In a future pass, we could implement compute_into to avoid this clone too.
            let vals = brain.compute(&inputs[in_offset..in_offset + self.num_inputs])?;
            
            // Copy results into shared buffer
            for (j, &val) in vals.iter().enumerate() {
                outputs[out_offset + j] = val;
            }
        }

        Ok(outputs.clone())
    }

    /// Evolve population based on fitness scores
    ///
    /// # Arguments
    ///
    /// * fitness_scores - Fitness for each agent (higher is better)
    /// * mutation_rate - Probability of mutating weights (0.0 to 1.0)
    /// * mutation_scale - Magnitude of mutations
    /// * strategy - Mutation algorithm to use
    ///
    /// # Returns
    ///
    /// Success or error if length mismatch
    ///
    /// # Algorithm
    ///
    /// # Design Note: Why No Tournament Selection?
    ///
    /// We use simple best-selection (elitism) because:
    /// - Simpler to understand for demos
    /// - Converges faster (good for quick visualization)
    /// - Avoids premature convergence via mutation diversity
    ///
    /// Production systems might use tournament selection, crossover, etc.
    pub fn evolve(
        &mut self,
        fitness_scores: &[f32],
        mutation_rate: f32,
        mutation_scale: f32,
        strategy: MutationStrategy,
    ) -> Result<(), JsValue> {
        let prev_len = self.brains.len();
        if fitness_scores.len() != prev_len {
            return Err(JsValue::from_str(&format!(
                "Fitness array length mismatch. Expected {}, got {}",
                prev_len,
                fitness_scores.len()
            )));
        }

        if prev_len == 0 {
            return Err(JsValue::from_str("Cannot evolve an empty population"));
        }

        // Find best brain by fitness
        let mut best_idx = 0;
        let mut best_score = -1.0;

        for (i, &score) in fitness_scores.iter().enumerate() {
            if score > best_score {
                best_score = score;
                best_idx = i;
            }
        }

        let best_brain = &self.brains[best_idx];
        let best_weights = best_brain.export_weights()?;

        let mut new_brains = Vec::with_capacity(prev_len);

        // 1. ELITE: First brain is exact copy of best
        let elite = NeuralBrain::new(0, self.num_inputs, self.hidden_layers.clone(), self.num_outputs)?;
        elite.import_weights(&best_weights)?;
        new_brains.push(elite);

        // 2. OFFSPRING: Rest are mutated copies
        let rng = &mut self.rng;

        for i in 1..prev_len {
            // Unique seed per offspring to ensure weight diversity
            let seed = i + (self.generation as usize * 1000);
            let offspring = NeuralBrain::new(seed, self.num_inputs, self.hidden_layers.clone(), self.num_outputs)?;
            offspring.import_weights(&best_weights)?;

            // Propagate global kernel to offspring
            offspring.set_kernel(
                self.global_kernel[0],
                self.global_kernel[1],
                self.global_kernel[2],
            );

            // Mutate offspring
            offspring.mutate(rng, mutation_rate, mutation_scale, strategy)?;
            new_brains.push(offspring);
        }

        // Safety check: Ensure we didn't lose the population
        if new_brains.is_empty() {
            return Err(JsValue::from_str("Evolution resulted in 0 brains"));
        }

        self.brains = new_brains;
        self.generation += 1;

        Ok(())
    }

    /// Get best brain's graph snapshot for visualization
    ///
    /// # Arguments
    ///
    /// * `fitness_scores` - Current fitness scores
    ///
    /// # Returns
    ///
    /// JavaScript value with best brain's graph structure, or NULL if mismatch
    ///
    /// # Use Case
    ///
    /// UI displays the brain of the highest-performing agent.
    pub fn get_best_brain_snapshot(&self, fitness_scores: &[f32]) -> JsValue {
        if fitness_scores.len() != self.brains.len() {
            return JsValue::NULL;
        }

        let mut best_idx = 0;
        let mut best_score = -1.0;
        for (i, &score) in fitness_scores.iter().enumerate() {
            if score > best_score {
                best_score = score;
                best_idx = i;
            }
        }

        self.brains[best_idx].get_graph_snapshot()
    }

    /// Set global convolution kernel for all brains
    ///
    /// # Arguments
    ///
    /// * `k1`, `k2`, `k3` - Kernel values
    ///
    /// # Effect
    ///
    /// Updates kernel for all current brains and stores for future offspring.
    ///
    /// # Use Case
    ///
    /// Allows runtime tuning of input preprocessing without restarting evolution.
    pub fn set_global_kernel(&mut self, k1: f32, k2: f32, k3: f32) {
        self.global_kernel = vec![k1, k2, k3];
        // Apply to current population as well
        for brain in self.brains.iter() {
            brain.set_kernel(k1, k2, k3);
        }
    }
}

#[cfg(all(test, target_arch = "wasm32"))]
mod tests {
    use super::*;

    #[test]
    fn test_population_creation() {
        let pop = Population::new(10, 4, vec![8], 2).unwrap();
        assert_eq!(pop.count(), 10);
    }

    #[test]
    fn test_population_zero_size() {
        let result = Population::new(0, 4, vec![8], 2);
        assert!(result.is_err());
    }

    #[test]
    fn test_compute_all() {
        let pop = Population::new(2, 3, vec![4], 2).unwrap();
        let inputs = vec![1.0, 0.5, -0.3, 0.8, -0.2, 0.4]; // 2 agents * 3 inputs
        let outputs = pop.compute_all(&inputs).unwrap();
        assert_eq!(outputs.len(), 4); // 2 agents * 2 outputs
    }

    #[test]
    fn test_compute_all_wrong_size() {
        let pop = Population::new(2, 3, vec![4], 2).unwrap();
        let inputs = vec![1.0, 0.5]; // Wrong size!
        let result = pop.compute_all(&inputs);
        assert!(result.is_err());
    }

    #[test]
    fn test_evolution() {
        let mut pop = Population::new(5, 4, vec![8], 2).unwrap();
        let fitness = vec![1.0, 5.0, 2.0, 3.0, 4.0]; // Agent 1 is best
        pop.evolve(&fitness, 0.15, 0.5, MutationStrategy::Additive)
            .unwrap();
        assert_eq!(pop.generation, 2);
    }

    #[test]
    fn test_evolution_wrong_fitness_size() {
        let mut pop = Population::new(5, 4, vec![8], 2).unwrap();
        let fitness = vec![1.0, 2.0]; // Wrong size!
        let result = pop.evolve(&fitness, 0.15, 0.5, MutationStrategy::Additive);
        assert!(result.is_err());
    }
}
