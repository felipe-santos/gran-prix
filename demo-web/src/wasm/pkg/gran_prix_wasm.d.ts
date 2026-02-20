/* tslint:disable */
/* eslint-disable */

export enum MutationStrategy {
    Additive = 0,
    Multiplicative = 1,
    Reset = 2,
}

export class NeuralBrain {
    free(): void;
    [Symbol.dispose](): void;
    compute(inputs: Float32Array): Float32Array;
    export_weights(): Float32Array;
    get_graph_snapshot(): any;
    import_weights(weights: Float32Array): void;
    constructor(seed_offset: number, num_inputs: number, hidden_size: number, num_outputs: number);
    reset(): void;
    set_kernel(k1: number, k2: number, k3: number): void;
    train(_sensors: Float32Array, _target: number): void;
}

export class Population {
    free(): void;
    [Symbol.dispose](): void;
    compute_all(inputs: Float32Array): Float32Array;
    count(): number;
    evolve(fitness_scores: Float32Array, mutation_rate: number, mutation_scale: number, strategy: MutationStrategy): void;
    get_best_brain_snapshot(fitness_scores: Float32Array): any;
    constructor(size: number, num_inputs: number, hidden_size: number, num_outputs: number);
    set_global_kernel(k1: number, k2: number, k3: number): void;
}

export class Trainer {
    free(): void;
    [Symbol.dispose](): void;
    get_decision_boundary(resolution: number): Float32Array;
    get_weights(): Float32Array;
    constructor(hidden_size: number);
    predict(x: number, y: number): number;
    train_batch(inputs_x: Float32Array, inputs_y: Float32Array, targets: Float32Array, lr: number): number;
    train_step(x: number, y: number, target_val: number, lr: number): number;
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
    readonly neuralbrain_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly neuralbrain_reset: (a: number) => void;
    readonly neuralbrain_set_kernel: (a: number, b: number, c: number, d: number) => void;
    readonly neuralbrain_train: (a: number, b: number, c: number, d: number) => [number, number];
    readonly population_compute_all: (a: number, b: number, c: number) => [number, number, number, number];
    readonly population_count: (a: number) => number;
    readonly population_evolve: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly population_get_best_brain_snapshot: (a: number, b: number, c: number) => any;
    readonly population_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly population_set_global_kernel: (a: number, b: number, c: number, d: number) => void;
    readonly trainer_get_decision_boundary: (a: number, b: number) => [number, number, number, number];
    readonly trainer_get_weights: (a: number) => [number, number, number, number];
    readonly trainer_new: (a: number) => [number, number, number];
    readonly trainer_predict: (a: number, b: number, c: number) => [number, number, number];
    readonly trainer_train_batch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly trainer_train_step: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
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
