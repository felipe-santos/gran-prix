/* tslint:disable */
/* eslint-disable */

/**
 * Mutation strategy for neural network weight evolution
 *
 * # Examples
 *
 * ```
 * use gran_prix_wasm::MutationStrategy;
 *
 * let strategy = MutationStrategy::Additive;
 * ```
 */
export enum MutationStrategy {
    /**
     * Add random noise: `weight + random(-scale, scale)`
     */
    Additive = 0,
    /**
     * Scale by random factor: `weight * (1.0 + random(-scale, scale))`
     */
    Multiplicative = 1,
    /**
     * Reset to random value: `weight = random(-scale, scale)`
     */
    Reset = 2,
}

/**
 * Neural network brain for evolutionary agents
 *
 * # Design
 *
 * `NeuralBrain` wraps a computation graph and exposes a simple `compute()`
 * interface for forward passes. It's designed for:
 *
 * - **Evolution**: Weights can be exported/imported/mutated
 * - **Zero-alloc inference**: Input tensor is pre-allocated
 * - **Corruption safety**: Magic number detects memory issues
 * - **WASM compatibility**: Uses `RefCell` for interior mutability
 *
 * # Examples
 *
 * ```no_run
 * use gran_prix_wasm::NeuralBrain;
 *
 * let brain = NeuralBrain::new(0, 4, 8, 2)?;
 * let outputs = brain.compute(&[1.0, 0.5, -0.3, 0.8])?;
 * ```
 */
export class NeuralBrain {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Compute forward pass through the network
     *
     * # Arguments
     *
     * * `inputs` - Input values (length must match `num_inputs` from constructor)
     *
     * # Returns
     *
     * Output values (length = `num_outputs`) or error
     *
     * # Errors
     *
     * - `"Corrupted before compute"`: Magic number mismatch (memory corruption)
     * - `"Re-entrant call detected"`: Attempting to call `compute` while already computing
     * - Graph execution errors
     *
     * # Performance
     *
     * This is the **hot path** for inference. Optimizations:
     * - Pre-allocated input tensor (no heap allocation)
     * - Single borrow of `RefCell` per phase
     * - Minimal error handling overhead
     */
    compute(inputs: Float32Array): Float32Array;
    /**
     * Export all network weights as flat vector
     *
     * # Returns
     *
     * Flattened weight vector in graph order
     *
     * # Use Case
     *
     * Used by evolution to extract parent weights for offspring.
     */
    export_weights(): Float32Array;
    /**
     * Get graph snapshot for visualization
     *
     * # Returns
     *
     * JavaScript value containing node information and activations
     *
     * # Use Case
     *
     * Used by UI to display network structure and activation values.
     */
    get_graph_snapshot(): any;
    /**
     * Import weights into network
     *
     * # Arguments
     *
     * * `weights` - Flat weight vector (must match network size)
     *
     * # Returns
     *
     * `Ok(())` on success, error if weight array is too short
     *
     * # Use Case
     *
     * Used by evolution to inject parent/mutated weights into offspring.
     *
     * # Important Note
     *
     * This works correctly when called on a **fresh brain** (newly constructed).
     * If called on an already-run brain, you must call `reset()` to clear cached values.
     */
    import_weights(weights: Float32Array): void;
    /**
     * Create a new neural network brain
     *
     * # Arguments
     *
     * * `seed_offset` - Seed for deterministic weight initialization
     * * `num_inputs` - Number of input neurons
     * * `hidden_size` - Number of hidden neurons
     * * `num_outputs` - Number of output neurons
     *
     * # Returns
     *
     * New brain instance or error if graph construction fails
     *
     * # Weight Initialization
     *
     * Weights are initialized with alternating signs to guarantee steering
     * variance in the population. This prevents all agents from behaving
     * identically at generation 0.
     *
     * w[i] = sign * 0.1 where sign = (-1)^(i + seed_offset)
     */
    constructor(seed_offset: number, num_inputs: number, hidden_layers: Uint32Array, num_outputs: number);
    /**
     * Reset cached values and gradients in the graph
     *
     * This is typically called between generations or training epochs.
     */
    reset(): void;
    /**
     * Set custom convolution kernel
     *
     * # Arguments
     *
     * * `k1`, `k2`, `k3` - Kernel values
     *
     * # Example
     *
     * ```no_run
     * brain.set_kernel(-0.5, 1.0, -0.5); // Edge detection
     * ```
     */
    set_kernel(k1: number, k2: number, k3: number): void;
    /**
     * Simple training step (placeholder for reinforcement learning)
     *
     * # Arguments
     *
     * * `_sensors` - Input sensor data (unused currently)
     * * `_target` - Target value (unused currently)
     *
     * # Returns
     *
     * Always `Ok(())` (no-op implementation)
     *
     * # Design Note
     *
     * This is a placeholder for future RL integration. Current evolution
     * doesn't use gradient-based learning.
     */
    train(_sensors: Float32Array, _target: number): void;
}

/**
 * Population of neural network agents
 *
 * Manages a collection of `NeuralBrain` instances and provides evolutionary
 * operators (selection, mutation, elitism).
 *
 * # Design Rationale
 *
 * - **Elitism**: Best agent always survives (prevents regression)
 * - **Asexual reproduction**: Mutation-only (no crossover)
 * - **Deterministic**: Same fitness sequence produces same evolution
 *
 * # Examples
 *
 * ```no_run
 * use gran_prix_wasm::{Population, MutationStrategy};
 *
 * let mut pop = Population::new(50, 4, &Uint32Array::from(&[8][..]), 2)?;
 * let fitness = vec![1.0; 50];
 * pop.evolve(&fitness, 0.15, 0.5, MutationStrategy::Additive)?;
 * ```
 */
export class Population {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Compute forward pass for all agents
     * Compute forward pass for all agents
     *
     * # Arguments
     *
     * * inputs - Flattened input array of shape (population_size * num_inputs)
     *
     * # Returns
     *
     * Flattened output array of shape (population_size * num_outputs)
     *
     * # Performance
     *
     * This is called every frame for all agents. Optimized for speed.
     */
    compute_all(inputs: Float32Array): Float32Array;
    /**
     * Get number of agents in population
     *
     * # Returns
     *
     * Population size
     */
    count(): number;
    /**
     * Evolve population based on fitness scores
     *
     * # Arguments
     *
     * * fitness_scores - Fitness for each agent (higher is better)
     * * mutation_rate - Probability of mutating weights (0.0 to 1.0)
     * * mutation_scale - Magnitude of mutations
     * * strategy - Mutation algorithm to use
     *
     * # Returns
     *
     * Success or error if length mismatch
     *
     * # Algorithm
     *
     * ```
     *
     * # Design Note: Why No Tournament Selection?
     *
     * We use simple best-selection (elitism) because:
     * - Simpler to understand for demos
     * - Converges faster (good for quick visualization)
     * - Avoids premature convergence via mutation diversity
     *
     * Production systems might use tournament selection, crossover, etc.
     */
    evolve(fitness_scores: Float32Array, mutation_rate: number, mutation_scale: number, strategy: MutationStrategy): void;
    /**
     * Get best brain's graph snapshot for visualization
     *
     * # Arguments
     *
     * * `fitness_scores` - Current fitness scores
     *
     * # Returns
     *
     * JavaScript value with best brain's graph structure, or NULL if mismatch
     *
     * # Use Case
     *
     * UI displays the brain of the highest-performing agent.
     */
    get_best_brain_snapshot(fitness_scores: Float32Array): any;
    /**
     * Create a new population
     *
     * # Arguments
     *
     * * `size` - Number of agents in population
     * * `num_inputs` - Input layer size for each brain
     * * `hidden_size` - Hidden layer size for each brain
     * * `num_outputs` - Output layer size for each brain
     *
     * # Returns
     *
     * New population or error if size is 0 or brain construction fails
     *
     * # Weight Initialization
     *
     * Each brain is initialized with a unique `seed_offset` based on its index.
     * This ensures diversity in initial population.
     */
    constructor(size: number, num_inputs: number, hidden_layers: Uint32Array, num_outputs: number);
    /**
     * Set global convolution kernel for all brains
     *
     * # Arguments
     *
     * * `k1`, `k2`, `k3` - Kernel values
     *
     * # Effect
     *
     * Updates kernel for all current brains and stores for future offspring.
     *
     * # Use Case
     *
     * Allows runtime tuning of input preprocessing without restarting evolution.
     */
    set_global_kernel(k1: number, k2: number, k3: number): void;
}

export class Trainer {
    free(): void;
    [Symbol.dispose](): void;
    get_decision_boundary(resolution: number, feature_map: Function): Float32Array;
    get_weights(): Float32Array;
    import_weights(weights: Float32Array): void;
    constructor(input_dim: number, hidden_layers: Uint32Array);
    predict(features: Float32Array): number;
    train_batch(inputs: Float32Array, targets: Float32Array, lr: number): number;
    train_step(features: Float32Array, target_val: number, lr: number): number;
}

export function init_panic_hook(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_neuralbrain_free: (a: number, b: number) => void;
    readonly neuralbrain_compute: (a: number, b: number, c: number) => [number, number, number, number];
    readonly neuralbrain_export_weights: (a: number) => [number, number, number, number];
    readonly neuralbrain_get_graph_snapshot: (a: number) => any;
    readonly neuralbrain_import_weights: (a: number, b: number, c: number) => [number, number];
    readonly neuralbrain_new: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly neuralbrain_reset: (a: number) => void;
    readonly neuralbrain_set_kernel: (a: number, b: number, c: number, d: number) => void;
    readonly neuralbrain_train: (a: number, b: number, c: number, d: number) => [number, number];
    readonly __wbg_trainer_free: (a: number, b: number) => void;
    readonly trainer_get_decision_boundary: (a: number, b: number, c: any) => [number, number, number, number];
    readonly trainer_get_weights: (a: number) => [number, number, number, number];
    readonly trainer_import_weights: (a: number, b: number, c: number) => [number, number];
    readonly trainer_new: (a: number, b: number, c: number) => [number, number, number];
    readonly trainer_predict: (a: number, b: number, c: number) => [number, number, number];
    readonly trainer_train_batch: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly trainer_train_step: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly __wbg_population_free: (a: number, b: number) => void;
    readonly population_compute_all: (a: number, b: number, c: number) => [number, number, number, number];
    readonly population_count: (a: number) => number;
    readonly population_evolve: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly population_get_best_brain_snapshot: (a: number, b: number, c: number) => any;
    readonly population_new: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly population_set_global_kernel: (a: number, b: number, c: number, d: number) => void;
    readonly init_panic_hook: () => void;
    readonly __wbindgen_malloc_command_export: (a: number, b: number) => number;
    readonly __wbindgen_realloc_command_export: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store_command_export: (a: number) => void;
    readonly __externref_table_alloc_command_export: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free_command_export: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc_command_export: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
