/* @ts-self-types="./gran_prix_wasm.d.ts" */

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
 * @enum {0 | 1 | 2}
 */
export const MutationStrategy = Object.freeze({
    /**
     * Add random noise: `weight + random(-scale, scale)`
     */
    Additive: 0, "0": "Additive",
    /**
     * Scale by random factor: `weight * (1.0 + random(-scale, scale))`
     */
    Multiplicative: 1, "1": "Multiplicative",
    /**
     * Reset to random value: `weight = random(-scale, scale)`
     */
    Reset: 2, "2": "Reset",
});

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
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        NeuralBrainFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_neuralbrain_free(ptr, 0);
    }
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
     * @param {Float32Array} inputs
     * @returns {Float32Array}
     */
    compute(inputs) {
        const ptr0 = passArrayF32ToWasm0(inputs, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.neuralbrain_compute(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free_command_export(ret[0], ret[1] * 4, 4);
        return v2;
    }
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
     * @returns {Float32Array}
     */
    export_weights() {
        const ret = wasm.neuralbrain_export_weights(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free_command_export(ret[0], ret[1] * 4, 4);
        return v1;
    }
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
     * @returns {any}
     */
    get_graph_snapshot() {
        const ret = wasm.neuralbrain_get_graph_snapshot(this.__wbg_ptr);
        return ret;
    }
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
     * @param {Float32Array} weights
     */
    import_weights(weights) {
        const ptr0 = passArrayF32ToWasm0(weights, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.neuralbrain_import_weights(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
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
     * @param {number} seed_offset
     * @param {number} num_inputs
     * @param {Uint32Array} hidden_layers
     * @param {number} num_outputs
     */
    constructor(seed_offset, num_inputs, hidden_layers, num_outputs) {
        const ptr0 = passArray32ToWasm0(hidden_layers, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.neuralbrain_new(seed_offset, num_inputs, ptr0, len0, num_outputs);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        NeuralBrainFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Reset cached values and gradients in the graph
     *
     * This is typically called between generations or training epochs.
     */
    reset() {
        wasm.neuralbrain_reset(this.__wbg_ptr);
    }
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
     * @param {number} k1
     * @param {number} k2
     * @param {number} k3
     */
    set_kernel(k1, k2, k3) {
        wasm.neuralbrain_set_kernel(this.__wbg_ptr, k1, k2, k3);
    }
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
     * @param {Float32Array} _sensors
     * @param {number} _target
     */
    train(_sensors, _target) {
        const ptr0 = passArrayF32ToWasm0(_sensors, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.neuralbrain_train(this.__wbg_ptr, ptr0, len0, _target);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) NeuralBrain.prototype[Symbol.dispose] = NeuralBrain.prototype.free;

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
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PopulationFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_population_free(ptr, 0);
    }
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
     * @param {Float32Array} inputs
     * @returns {Float32Array}
     */
    compute_all(inputs) {
        const ptr0 = passArrayF32ToWasm0(inputs, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.population_compute_all(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free_command_export(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * Get number of agents in population
     *
     * # Returns
     *
     * Population size
     * @returns {number}
     */
    count() {
        const ret = wasm.population_count(this.__wbg_ptr);
        return ret >>> 0;
    }
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
     * @param {Float32Array} fitness_scores
     * @param {number} mutation_rate
     * @param {number} mutation_scale
     * @param {MutationStrategy} strategy
     */
    evolve(fitness_scores, mutation_rate, mutation_scale, strategy) {
        const ptr0 = passArrayF32ToWasm0(fitness_scores, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.population_evolve(this.__wbg_ptr, ptr0, len0, mutation_rate, mutation_scale, strategy);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
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
     * @param {Float32Array} fitness_scores
     * @returns {any}
     */
    get_best_brain_snapshot(fitness_scores) {
        const ptr0 = passArrayF32ToWasm0(fitness_scores, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.population_get_best_brain_snapshot(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
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
     * @param {number} size
     * @param {number} num_inputs
     * @param {Uint32Array} hidden_layers
     * @param {number} num_outputs
     */
    constructor(size, num_inputs, hidden_layers, num_outputs) {
        const ptr0 = passArray32ToWasm0(hidden_layers, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.population_new(size, num_inputs, ptr0, len0, num_outputs);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        PopulationFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
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
     * @param {number} k1
     * @param {number} k2
     * @param {number} k3
     */
    set_global_kernel(k1, k2, k3) {
        wasm.population_set_global_kernel(this.__wbg_ptr, k1, k2, k3);
    }
}
if (Symbol.dispose) Population.prototype[Symbol.dispose] = Population.prototype.free;

export class Trainer {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TrainerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_trainer_free(ptr, 0);
    }
    /**
     * @param {number} resolution
     * @param {Function} feature_map
     * @returns {Float32Array}
     */
    get_decision_boundary(resolution, feature_map) {
        const ret = wasm.trainer_get_decision_boundary(this.__wbg_ptr, resolution, feature_map);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free_command_export(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get_weights() {
        const ret = wasm.trainer_get_weights(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free_command_export(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {Float32Array} weights
     */
    import_weights(weights) {
        const ptr0 = passArrayF32ToWasm0(weights, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.trainer_import_weights(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} input_dim
     * @param {Uint32Array} hidden_layers
     */
    constructor(input_dim, hidden_layers) {
        const ptr0 = passArray32ToWasm0(hidden_layers, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.trainer_new(input_dim, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        TrainerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Float32Array} features
     * @returns {number}
     */
    predict(features) {
        const ptr0 = passArrayF32ToWasm0(features, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.trainer_predict(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Float32Array} inputs
     * @param {Float32Array} targets
     * @param {number} lr
     * @returns {number}
     */
    train_batch(inputs, targets, lr) {
        const ptr0 = passArrayF32ToWasm0(inputs, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(targets, wasm.__wbindgen_malloc_command_export);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.trainer_train_batch(this.__wbg_ptr, ptr0, len0, ptr1, len1, lr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Float32Array} features
     * @param {number} target_val
     * @param {number} lr
     * @returns {number}
     */
    train_step(features, target_val, lr) {
        const ptr0 = passArrayF32ToWasm0(features, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.trainer_train_step(this.__wbg_ptr, ptr0, len0, target_val, lr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
}
if (Symbol.dispose) Trainer.prototype[Symbol.dispose] = Trainer.prototype.free;

export function init_panic_hook() {
    wasm.init_panic_hook();
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_8c4e43fe74559d73: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_debug_string_0bc8482c6e3508ae: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc_command_export, wasm.__wbindgen_realloc_command_export);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_is_function_0095a73b8b156f76: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_5ae8e5880f2c1fbd: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_cd444516edc5b180: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_9e4d92534c42d778: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_throw_be289d5034ed271b: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_389efe28435a9388: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_call_4708e0c13bdc8e95: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_call_812d25f1510c13c8: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_crypto_86f2631e91b51511: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_error_7534b8e9a36f1ab4: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free_command_export(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_getRandomValues_b3f15fcbfabb0f8b: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_instanceof_Float32Array_c882a172bf41d92a: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Float32Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_length_32ed9a279acd054c: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_9a7876c9728a0979: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_msCrypto_d562bbe83e0d4b91: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_361308b2356cecd0: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_3eb36ae241fe6f44: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_8a6f238a6ece86ea: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_no_args_1c7c842f08d00ebb: function(arg0, arg1) {
            const ret = new Function(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_with_length_a2c39cbe88fd8ff1: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_node_e1f24f89a7336c2e: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_process_3975fd6c72f520aa: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_bdcdcc5842e4d77d: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_prototypesetcall_c7e6a26aeade796d: function(arg0, arg1, arg2) {
            Float32Array.prototype.set.call(getArrayF32FromWasm0(arg0, arg1), arg2);
        },
        __wbg_randomFillSync_f8c153b79f285817: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b74f47fc2d022fd6: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_set_3fda3bac07393de4: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_f43e577aea94465b: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_stack_0ed75d68575b0f3c: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc_command_export, wasm.__wbindgen_realloc_command_export);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_12837167ad935116: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_e628e89ab3b1c95f: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_a621d3dfbb60d0ce: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_f8727f0cf888e0bd: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_subarray_a96e1fef17ed23cb: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_versions_4e31226f5e8dc909: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000004: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./gran_prix_wasm_bg.js": import0,
    };
}

const NeuralBrainFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_neuralbrain_free(ptr >>> 0, 1));
const PopulationFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_population_free(ptr >>> 0, 1));
const TrainerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_trainer_free(ptr >>> 0, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc_command_export();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store_command_export(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc_command_export(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('gran_prix_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
