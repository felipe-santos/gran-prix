import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { sha256Of, type Sha256 } from "@gran-prix/contracts";

/** The slice of the `@gran-prix/wasm` Trainer the loader uses. */
export interface WasmTrainerApi {
  free(): void;
  import_weights(weights: Float32Array): void;
  get_weights(): Float32Array;
  networkDefJson(): string;
  paramShapes(): Array<{ name: string; shape: number[]; offset: number; len: number }>;
  /** Number of parameter tensors (`paramShapes().length`). NOT the number of floats. */
  paramTensorCount(): number;
  /** Number of scalar weights (floats): `get_weights().length`. */
  weightCount(): number;
  inputDim(): number;
  outputDim(): number;
  /** Output head applied: sigmoid for one output, row-wise softmax otherwise. */
  predictProbsBatch(inputs: Float32Array, n: number): Float32Array;
  /** Raw network outputs (logits) for `n` row-major samples: the exact input of calibration and the output head. */
  predictLogitsBatch(inputs: Float32Array, n: number): Float32Array;
}

export interface WasmValidation {
  ok: boolean;
  errors: string[];
  inputDim?: number;
  outputDim?: number;
  /** Number of scalar weights (floats): the expected length of weights.f32le / 4. */
  weightCount?: number;
}

/** The slice of the node-target `@gran-prix/wasm` module the loader uses. */
export interface WasmApi {
  Trainer: { fromNetworkDef(json: string): WasmTrainerApi };
  validateNetworkDef(json: string): WasmValidation;
}

/** Environment override: path to a `gran_prix_wasm.js` (node target), as the smoke tests accept. */
export const WASM_ENV = "GRAN_PRIX_WASM_NODE";

const BUILD_HINT =
  "build it first: node scripts/build-wasm.mjs --target both --web-out packages/wasm/dist/web --node-out packages/wasm/dist/node";

/** Absolute path of the node-target `gran_prix_wasm.js` (env override, else `@gran-prix/wasm/node`). */
export function wasmEntryPath(): string {
  const fromEnv = process.env[WASM_ENV];
  if (fromEnv) return fromEnv;
  try {
    return createRequire(import.meta.url).resolve("@gran-prix/wasm/node");
  } catch (e) {
    throw new Error(`cannot resolve @gran-prix/wasm/node (${e instanceof Error ? e.message : String(e)}); ${BUILD_HINT}`);
  }
}

let cached: { entry: string; api: WasmApi } | undefined;

/** Loads (once) the node-target WASM build. */
export function loadWasm(): WasmApi {
  const entry = wasmEntryPath();
  if (cached?.entry === entry) return cached.api;
  let api: WasmApi;
  try {
    api = createRequire(import.meta.url)(entry) as WasmApi;
  } catch (e) {
    throw new Error(`cannot load the WASM build at ${entry} (${e instanceof Error ? e.message : String(e)}); ${BUILD_HINT}`);
  }
  cached = { entry, api };
  return api;
}

/** sha256 of the `gran_prix_wasm_bg.wasm` binary that `loadWasm` runs: the `wasm_sha256` of cache keys and provenance. */
export function wasmSha256(): Sha256 {
  const file = join(dirname(wasmEntryPath()), "gran_prix_wasm_bg.wasm");
  return sha256Of(new Uint8Array(readFileSync(file)));
}
