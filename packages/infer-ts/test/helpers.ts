import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = join(here, '..');
export const GENERATED_DIR = join(PKG_ROOT, '.generated');

/** The shape of the nodejs wasm-pack build that the tests use. */
export interface WasmTrainer {
  free(): void;
  get_weights(): Float32Array;
  networkDefJson(): string;
  paramShapes(): Array<{ name: string; shape: number[]; offset: number; len: number }>;
  paramCount(): number;
  train_batch(inputs: Float32Array, targets: Float32Array, lr: number): number;
  trainBatchMultiClass(inputs: Float32Array, classes: Uint32Array, lr: number): number;
  predict(features: Float32Array): number;
  predictProbs(features: Float32Array): Float32Array;
  predictProbsBatch(inputs: Float32Array, n: number): Float32Array;
  predictBatch(inputs: Float32Array, n: number): Float32Array;
}

export interface WasmModule {
  Trainer: {
    fromNetworkDefSeeded(json: string, seed: number): WasmTrainer;
    fromNetworkDefWithLossSeeded(json: string, loss: number, seed: number): WasmTrainer;
  };
  LossKind: { BinaryCrossEntropy: number; CategoricalCrossEntropy: number };
  validateNetworkDef(json: string): {
    ok: boolean;
    errors: string[];
    inputDim?: number;
    outputDim?: number;
    paramCount?: number;
  };
}

const WASM_ENTRY = join(PKG_ROOT, '..', 'wasm', 'dist', 'node', 'gran_prix_wasm.js');

/** Loads packages/wasm/dist/node, failing with the build command when missing. */
export function loadWasm(): WasmModule {
  if (!existsSync(WASM_ENTRY)) {
    throw new Error(
      `WASM build not found at ${WASM_ENTRY}. Build it first:\n` +
        '  node scripts/build-wasm.mjs --target nodejs --node-out packages/wasm/dist/node',
    );
  }
  return createRequire(import.meta.url)(WASM_ENTRY) as WasmModule;
}

/** Deterministic LCG in [-1, 1) (same family as the Rust tests). */
export class Lcg {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (Math.imul(this.s, 1103515245) + 12345) & 0x7fffffff;
    return (this.s / 2147483648) * 2 - 1;
  }
  floats(n: number, scale = 1): Float32Array {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.next() * scale;
    return out;
  }
}

/** Writes `code` to `.generated/<name>.ts` and imports it. */
export async function materialize<T = GeneratedModule>(name: string, code: string): Promise<T> {
  mkdirSync(GENERATED_DIR, { recursive: true });
  const file = join(GENERATED_DIR, `${name}.ts`);
  writeFileSync(file, code);
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as T;
}

export function generatedPath(name: string): string {
  return join(GENERATED_DIR, `${name}.ts`);
}

/** Surface of a generated module. */
export interface GeneratedModule {
  NETWORK_DEF_DIGEST: string;
  WEIGHTS_DIGEST: string;
  INPUT_DIM: number;
  OUTPUT_DIM: number;
  PARAM_COUNT: number;
  HEAD: 'sigmoid' | 'softmax' | 'none';
  predictLogits(input: Float32Array): Float32Array;
  predictLogitsBatch(inputs: Float32Array, n: number): Float32Array;
  predictProbs(input: Float32Array): Float32Array;
  predictBatch(inputs: Float32Array, n: number): Float32Array;
}

export type Layer =
  | { type: 'linear'; in_features: number; out_features: number }
  | { type: 'activation'; function: 'relu' | 'tanh' | 'sigmoid' | 'softmax' }
  | { type: 'dropout'; rate: number };

/** `input -> (linear + act)* hidden -> linear(out)`; no terminal activation (logits). */
export function mlp(
  inputDim: number,
  hidden: number[],
  outDim: number,
  act: 'relu' | 'tanh' | 'sigmoid' | 'softmax',
  opts: { dropout?: number; leadingActivation?: boolean } = {},
): { input_dim: number; layers: Layer[] } {
  const layers: Layer[] = [];
  if (opts.leadingActivation) layers.push({ type: 'activation', function: act });
  let prev = inputDim;
  for (const h of hidden) {
    layers.push({ type: 'linear', in_features: prev, out_features: h });
    layers.push({ type: 'activation', function: act });
    if (opts.dropout !== undefined) layers.push({ type: 'dropout', rate: opts.dropout });
    prev = h;
  }
  layers.push({ type: 'linear', in_features: prev, out_features: outDim });
  return { input_dim: inputDim, layers };
}

/** A few training steps so weights and biases are non-trivial. */
export function trainSome(trainer: WasmTrainer, inputDim: number, outDim: number, steps: number, seed = 7): void {
  const rng = new Lcg(seed);
  const batch = 32;
  for (let s = 0; s < steps; s++) {
    const x = rng.floats(batch * inputDim);
    if (outDim === 1) {
      const y = new Float32Array(batch);
      for (let i = 0; i < batch; i++) y[i] = x[i * inputDim] * x[i * inputDim + 1] > 0 ? 1 : 0;
      trainer.train_batch(x, y, 0.05);
    } else {
      const y = new Uint32Array(batch);
      for (let i = 0; i < batch; i++) y[i] = Math.floor(((x[i * inputDim] + 1) / 2) * outDim) % outDim;
      trainer.trainBatchMultiClass(x, y, 0.05);
    }
  }
}

export function bitsOf(a: Float32Array): number[] {
  return Array.from(new Uint32Array(a.buffer, a.byteOffset, a.length));
}

export function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`length mismatch ${a.length} vs ${b.length}`);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}
