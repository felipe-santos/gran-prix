/* tslint:disable */
/* eslint-disable */

export class NeuralBrain {
    free(): void;
    [Symbol.dispose](): void;
    compute(s1: number, s2: number, s3: number, s4: number, s5: number): number;
    constructor();
    reset(): void;
    train(sensors: Float32Array, target: number): void;
}

export function init_panic_hook(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_neuralbrain_free: (a: number, b: number) => void;
    readonly neuralbrain_compute: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly neuralbrain_new: () => [number, number, number];
    readonly neuralbrain_reset: (a: number) => void;
    readonly neuralbrain_train: (a: number, b: number, c: number, d: number) => [number, number];
    readonly init_panic_hook: () => void;
    readonly __wbindgen_free_command_export: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc_command_export: (a: number, b: number) => number;
    readonly __wbindgen_realloc_command_export: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
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
