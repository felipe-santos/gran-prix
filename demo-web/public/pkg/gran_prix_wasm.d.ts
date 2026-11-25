/* tslint:disable */
/* eslint-disable */

/**
 * Loss function used by a [`Trainer`]. Auto-detected from the
 * underlying [`NetworkDef`]'s output dimension at construction time:
 * `output_dim == 1` → `BinaryCrossEntropy`, otherwise
 * `CategoricalCrossEntropy`. Determines:
 *
 *  - Which loss is used in [`train_batch`] / [`train_batch_multi_class`]
 *  - How [`predict_probs`] interprets logits (sigmoid vs row-softmax)
 *  - Which methods are valid (binary methods error on multi-class
 *    trainers and vice versa)
 */
export enum LossKind {
    /**
     * Binary classification head — single-logit output, sigmoid for
     * inference, BCE-with-logits for training.
     */
    BinaryCrossEntropy = 0,
    /**
     * Multi-class classification head — `K`-logit output, row-wise
     * softmax for inference, CrossEntropy-with-logits for training.
     */
    CategoricalCrossEntropy = 1,
}

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
 * let brain = NeuralBrain::new(0, 4, vec![8], 2).unwrap();
 * let outputs = brain.compute(&[1.0, 0.5, -0.3, 0.8]).unwrap();
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
     * Alias for `reset_memory()`. Maintained for backward compatibility.
     */
    reset(): void;
    /**
     * Reset cached values and gradients in the graph
     *
     * This is typically called between generations or training epochs.
     */
    reset_memory(): void;
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
     * # use gran_prix_wasm::NeuralBrain;
     * # let brain = NeuralBrain::new(0, 4, vec![8], 2).unwrap();
     * brain.set_kernel(-0.5, 1.0, -0.5); // Edge detection
     * ```
     */
    set_kernel(k1: number, k2: number, k3: number): void;
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
 * let mut pop = Population::new(50, 4, vec![8], 2).unwrap();
 * let fitness = vec![1.0; 50];
 * pop.evolve(&fitness, 0.15, 0.5, MutationStrategy::Additive).unwrap();
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
     * Reset memory states for all brains in the population.
     * This is crucial for RNN/GRU networks at the start of a new episode.
     */
    reset_memories(): void;
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
    /**
     * Freezes every trainable parameter whose registered name starts
     * with `prefix`, returning the indices of the parameters that
     * were affected (in registration order).
     *
     * `NetworkDef::compile` registers parameters with names like
     * `"layers[3].weight"`, so a prefix of `"layers[3]"` freezes the
     * fourth layer atomically. Layers indexed by activation-only
     * `LayerDef`s contribute no parameters; their indices appear as
     * gaps in the namespace.
     *
     * An empty return vector means no parameter matched — common if
     * the caller passed a typo. The method does not error in that
     * case because the absence of a match isn't necessarily a bug.
     * Returning the affected indices lets callers audit "did I
     * freeze the right parameters?" — for instance by passing the
     * vector to [`param_name`] for a logging readback.
     */
    freezeByPrefix(prefix: string): Uint32Array;
    /**
     * Creates a trainer from a [`NetworkDef`] JSON string.
     *
     * This replaces the old `WasmArchitecture` format. The JSON schema
     * is defined by the core `NetworkDef` type:
     *
     * ```json
     * {
     *   "input_dim": 2,
     *   "layers": [
     *     { "type": "linear", "in_features": 2, "out_features": 8 },
     *     { "type": "activation", "function": "relu" },
     *     { "type": "linear", "in_features": 8, "out_features": 1 }
     *   ]
     * }
     * ```
     */
    static fromNetworkDef(json: string): Trainer;
    /**
     * Like [`Trainer::from_network_def`], but all random weights are derived
     * deterministically from `seed`: the same `(json, seed)` always produces
     * bit-identical weights (`get_weights()`), independent of `Math.random`
     * or the platform RNG.
     *
     * The seed is a `u32` so JavaScript callers can pass a plain `number`
     * (no `BigInt`); it is widened to `u64` internally.
     */
    static fromNetworkDefSeeded(json: string, seed: number): Trainer;
    /**
     * Like [`from_network_def`], but with an explicit `loss_kind`
     * instead of auto-detection from `output_dim`. Use this when the
     * auto-detection rule isn't right — e.g., a network with
     * `output_dim == 2` that the caller wants to treat as two
     * independent binary heads (`BinaryCrossEntropy`) rather than a
     * 2-class softmax (`CategoricalCrossEntropy`).
     *
     * Errors if the terminal activation in the architecture is
     * incompatible with the chosen loss (see `validate_loss_compat`).
     */
    static fromNetworkDefWithLoss(json: string, loss_kind: LossKind): Trainer;
    /**
     * Seeded variant of [`Trainer::from_network_def_with_loss`]
     * (explicit `loss_kind`, deterministic weights from a `u32` `seed`).
     */
    static fromNetworkDefWithLossSeeded(json: string, loss_kind: LossKind, seed: number): Trainer;
    get_decision_boundary(resolution: number, feature_map: Function): Float32Array;
    get_gradient_norms(): Float32Array;
    get_weights(): Float32Array;
    import_weights(weights: Float32Array): void;
    /**
     * Returns the input feature dimensionality.
     */
    inputDim(): number;
    /**
     * Returns whether the parameter at `index` is currently frozen.
     * Out-of-range indices return `false` (consistent with
     * [`param_name`]'s out-of-range behavior).
     */
    isFrozenByIndex(index: number): boolean;
    /**
     * Returns the loss/output mode for this trainer. See [`LossKind`]
     * for the auto-detection rule.
     */
    lossKind(): LossKind;
    /**
     * Returns the canonical [`NetworkDef`] JSON used to construct this
     * trainer.
     *
     * The pair `(networkDefJson(), getWeights())` is the canonical
     * serialization contract for distributing a trained model:
     * reconstruct via [`from_network_def`] + [`import_weights`] and
     * the predictions are bit-identical (pinned by
     * `tests/persistence_e2e.rs`). The full `Graph` serde path also
     * works for trained MLPs (pinned by
     * `serde_json_to_string_round_trips_a_trained_graph`), but uses a
     * less explicit contract — prefer the JSON+weights pair for
     * anything crossing a trust boundary (disk, network, browser
     * storage).
     */
    networkDefJson(): string;
    /**
     * Creates a trainer with a simple MLP: Input → (Linear+Tanh)×N → Linear(1).
     *
     * This is the constructor used by the Playground for binary classification.
     */
    constructor(input_dim: number, hidden_layers: Uint32Array);
    /**
     * Returns the output dimensionality (number of classes for
     * multi-class, 1 for binary).
     */
    outputDim(): number;
    /**
     * Returns the total number of registered parameters. Use with
     * [`param_name`] / [`is_frozen_by_index`] to enumerate without
     * pulling the full name list across the JS↔WASM boundary.
     */
    paramCount(): number;
    /**
     * Returns the registered name of the parameter at `index`.
     *
     * Returns the empty string for out-of-range indices rather than
     * erroring — this matches the convention `wasm-bindgen` uses
     * for getters, where a `null`/empty value is more ergonomic than
     * a thrown exception. Callers that need bound-checked access can
     * gate on [`param_count`].
     */
    paramName(index: number): string;
    /**
     * Returns the registered names of all parameters as a
     * `string[]`. **Allocates and clones each name on every call.**
     * For hot paths, prefer [`param_count`] + [`param_name`] or
     * cache the result on the JS side.
     */
    paramNames(): string[];
    /**
     * Runs a single forward pass and returns a sigmoid-mapped probability.
     *
     * **Output assumption.** This trainer is wired for binary
     * classification: training uses [`BCEWithLogits`], `predict` reads
     * `slice[0]` of the network's output and applies sigmoid. If the
     * underlying [`NetworkDef`] declares `output_dim > 1`, this method
     * silently ignores all but the first output element. Multi-class
     * classification needs a different inference path (softmax), which
     * is documented as a deferred capability in `KNOWN-GAPS.md`.
     */
    predict(features: Float32Array): number;
    /**
     * Batched inference over a flat input buffer.
     *
     * `inputs` must be `batch_size * input_dim` floats laid out
     * row-major (i.e., sample `i`'s features start at index
     * `i * input_dim`). The output is `batch_size` probabilities,
     * each sigmoid-mapped from the network's logit output for the
     * corresponding sample — one per row of the input.
     *
     * # Performance
     *
     * This is a **single forward pass** with batch dimension `B`,
     * not `B` independent forwards. The cost of `predict_batch(B)`
     * is approximately the cost of one matmul over `[B, in] x [in, out]`
     * instead of `B` matmuls over `[1, in] x [in, out]`. For DOM
     * classification with thousands of nodes, this is the difference
     * between an `O(B)` JS↔WASM boundary cost and a single boundary
     * crossing.
     *
     * # Equivalence with `predict`
     *
     * For an MLP without `BatchNorm`, `predict_batch` is bit-equivalent
     * to calling `predict` once per row. Networks containing
     * `BatchNorm` are *not* bit-equivalent because BN computes batch
     * statistics from the input batch — single-sample BN falls back
     * to affine, batched BN uses the row-wise statistics. This
     * matches the documented design of `BatchNorm` in
     * `src/layers/batchnorm.rs`.
     *
     * # Externally observable state
     *
     * None. The input node's tensor is snapshotted at entry,
     * transiently widened to `[batch_size, input_dim]` for the
     * forward pass, then restored to its exact original value at
     * exit (success or error). Concurrent observers of the input
     * node would see the temporary state — but `Trainer` is not
     * `Send` / `Sync` and is meant for single-threaded use, so
     * there's no real observer.
     *
     * # Output assumption
     *
     * Binary-classification path (sigmoid). For multi-class trainers
     * this method returns an error — use [`predict_probs_batch`]
     * instead.
     */
    predictBatch(inputs: Float32Array, batch_size: number): Float32Array;
    /**
     * Returns the predicted class index (argmax of [`predict_probs`]).
     *
     * For a binary trainer this is `1` if `P(class=1) >= 0.5`,
     * otherwise `0` — the natural default. For a multi-class trainer
     * it's `argmax_i softmax(logits)[i]`, breaking ties in favor of
     * the lowest index (`>` rather than `>=` in the scan).
     *
     * Use [`predict_class_with_threshold`] to override the binary
     * decision threshold; production deployments often tune it via
     * precision/recall trade-off rather than fixing it at 0.5.
     */
    predictClass(features: Float32Array): number;
    /**
     * Like [`predict_class`] but with a caller-supplied decision
     * threshold for the binary case.
     *
     * `threshold` must be in `[0, 1]`. For multi-class trainers the
     * threshold is ignored — the choice is always argmax — and a
     * threshold outside `[0, 1]` is rejected for both modes (catches
     * caller errors like passing `0.5` as a logit instead of a
     * probability).
     */
    predictClassWithThreshold(features: Float32Array, threshold: number): number;
    /**
     * Returns the full output distribution for a single sample.
     *
     * Output shape:
     *  - Binary trainer (`output_dim == 1`): a 1-element vector
     *    containing the sigmoid of the logit, i.e. `P(class=1)`.
     *  - Multi-class trainer: an `output_dim`-element vector of
     *    softmax probabilities summing to 1.
     *
     * Works for both modes — callers that don't care about the
     * distinction can use this uniformly. Use [`predict_class`] if
     * only the argmax is needed.
     */
    predictProbs(features: Float32Array): Float32Array;
    /**
     * Batched version of [`predict_probs`].
     *
     * Output is row-major flat: `output[i * output_dim + c]` is the
     * probability of class `c` for sample `i`. Length is
     * `batch_size * output_dim`.
     *
     * Same single-forward batched semantics as [`predict_batch`].
     * Side effect: input node is widened then reset to
     * `[1, input_dim]` zeros at exit.
     */
    predictProbsBatch(inputs: Float32Array, batch_size: number): Float32Array;
    /**
     * Trains one batch using `CrossEntropyWithLogits`.
     *
     * `inputs` is `batch_size * input_dim` floats row-major.
     * `class_indices` is `batch_size` class labels in `0..output_dim`.
     * Each label is one-hot encoded internally to a `[1, output_dim]`
     * target tensor — this is what the underlying loss function
     * expects.
     *
     * Returns the mean loss across the batch.
     *
     * Errors if any class index is out of range, or if this trainer
     * is binary-mode (use [`train_batch`] instead).
     */
    trainBatchMultiClass(inputs: Float32Array, class_indices: Uint32Array, lr: number): number;
    train_batch(inputs: Float32Array, targets: Float32Array, lr: number): number;
    train_step(features: Float32Array, target_val: number, lr: number): number;
    /**
     * Inverse of [`freezeByPrefix`].
     */
    unfreezeByPrefix(prefix: string): Uint32Array;
}

export function init_panic_hook(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_neuralbrain_free: (a: number, b: number) => void;
    readonly __wbg_population_free: (a: number, b: number) => void;
    readonly __wbg_trainer_free: (a: number, b: number) => void;
    readonly init_panic_hook: () => void;
    readonly neuralbrain_compute: (a: number, b: number, c: number) => [number, number, number, number];
    readonly neuralbrain_export_weights: (a: number) => [number, number, number, number];
    readonly neuralbrain_get_graph_snapshot: (a: number) => any;
    readonly neuralbrain_import_weights: (a: number, b: number, c: number) => [number, number];
    readonly neuralbrain_new: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly neuralbrain_reset: (a: number) => void;
    readonly neuralbrain_set_kernel: (a: number, b: number, c: number, d: number) => void;
    readonly population_compute_all: (a: number, b: number, c: number) => [number, number, number, number];
    readonly population_count: (a: number) => number;
    readonly population_evolve: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly population_get_best_brain_snapshot: (a: number, b: number, c: number) => any;
    readonly population_new: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly population_reset_memories: (a: number) => void;
    readonly population_set_global_kernel: (a: number, b: number, c: number, d: number) => void;
    readonly trainer_freezeByPrefix: (a: number, b: number, c: number) => [number, number];
    readonly trainer_fromNetworkDef: (a: number, b: number) => [number, number, number];
    readonly trainer_fromNetworkDefSeeded: (a: number, b: number, c: number) => [number, number, number];
    readonly trainer_fromNetworkDefWithLoss: (a: number, b: number, c: number) => [number, number, number];
    readonly trainer_fromNetworkDefWithLossSeeded: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly trainer_get_decision_boundary: (a: number, b: number, c: any) => [number, number, number, number];
    readonly trainer_get_gradient_norms: (a: number) => [number, number, number, number];
    readonly trainer_get_weights: (a: number) => [number, number, number, number];
    readonly trainer_import_weights: (a: number, b: number, c: number) => [number, number];
    readonly trainer_inputDim: (a: number) => number;
    readonly trainer_isFrozenByIndex: (a: number, b: number) => number;
    readonly trainer_lossKind: (a: number) => number;
    readonly trainer_networkDefJson: (a: number) => [number, number];
    readonly trainer_new: (a: number, b: number, c: number) => [number, number, number];
    readonly trainer_outputDim: (a: number) => number;
    readonly trainer_paramCount: (a: number) => number;
    readonly trainer_paramName: (a: number, b: number) => [number, number];
    readonly trainer_paramNames: (a: number) => [number, number];
    readonly trainer_predict: (a: number, b: number, c: number) => [number, number, number];
    readonly trainer_predictBatch: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly trainer_predictClass: (a: number, b: number, c: number) => [number, number, number];
    readonly trainer_predictClassWithThreshold: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly trainer_predictProbs: (a: number, b: number, c: number) => [number, number, number, number];
    readonly trainer_predictProbsBatch: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly trainer_trainBatchMultiClass: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly trainer_train_batch: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly trainer_train_step: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly trainer_unfreezeByPrefix: (a: number, b: number, c: number) => [number, number];
    readonly neuralbrain_reset_memory: (a: number) => void;
    readonly __wbindgen_malloc_command_export: (a: number, b: number) => number;
    readonly __wbindgen_realloc_command_export: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store_command_export: (a: number) => void;
    readonly __externref_table_alloc_command_export: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free_command_export: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc_command_export: (a: number) => void;
    readonly __externref_drop_slice_command_export: (a: number, b: number) => void;
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
