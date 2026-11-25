import { modelId, type ModelPackage, type Sha256 } from "@gran-prix/contracts";
import type { Predictor } from "@gran-prix/infer-ts";
import {
  SUPPORTED_WASM_ABIS,
  checkDigests,
  checkDimensions,
  checkFiles,
  checkManifest,
  checkNetworkDefDigest,
  checkNetworkDefValid,
  checkRoundTrip,
  checkWeightsLayout,
  type CheckFn,
  type LoadState,
} from "./checks.js";
import { CHECKS, type CheckId } from "./errors.js";
import { checkGolden, type Tolerance } from "./golden.js";
import { normalizeBatch, oodFeatures, scoreFromLogits } from "./output.js";
import { loadWasm, type WasmApi, type WasmTrainerApi } from "./wasm.js";

export type Runtime = "ts" | "wasm";

export interface LoadOptions {
  /** Runtime behind `predict*` (default `ts`). Both runtimes are always verified against golden.json. */
  runtime?: Runtime;
  /** Overrides the tolerance of golden.json. */
  tolerance?: Tolerance;
  /** Injected WASM module (default: `@gran-prix/wasm/node`, or the file in GRAN_PRIX_WASM_NODE). */
  wasm?: WasmApi;
  /** `requires.runtime.wasm_abi` values to accept (default: the ones this loader knows). */
  supportedAbis?: readonly string[];
}

export interface CheckReport {
  n: number;
  id: CheckId;
  title: string;
  durationMs: number;
}

/** A verified ModelPackage. Inputs are extractor outputs (BEFORE normalization). */
export interface LoadedModel {
  readonly dir: string;
  /** Behavior hash (ADR-003), recomputed from model.json. */
  readonly modelId: Sha256;
  readonly manifest: ModelPackage;
  readonly runtime: Runtime;
  readonly inputDim: number;
  readonly outputDim: number;
  readonly labels: readonly string[];
  readonly thresholds: ModelPackage["thresholds"];
  /** The nine checks, all passed. */
  readonly checks: readonly CheckReport[];
  readonly warnings: readonly string[];
  /** Raw weights (f32), as verified. */
  readonly weights: Float32Array;
  /** Final output (calibration + activation) for one sample of `inputDim` extractor values. */
  predictProbs(features: ArrayLike<number>): Float32Array;
  /** Final output for `n` row-major samples (`n * outputDim` values). */
  predictBatch(features: ArrayLike<number>, n: number): Float32Array;
  /** Indices of the features of one sample outside `feature_spec.ood`. */
  oodFeatures(features: ArrayLike<number>): number[];
  /** Releases the WASM trainer. The handle must not be used afterwards. */
  dispose(): void;
}

const PIPELINE: ReadonlyArray<{ id: CheckId; run: CheckFn }> = [
  { id: "manifest", run: checkManifest },
  { id: "files", run: checkFiles },
  { id: "digests", run: checkDigests },
  { id: "network-def-digest", run: checkNetworkDefDigest },
  { id: "network-def-valid", run: checkNetworkDefValid },
  { id: "dimensions", run: checkDimensions },
  { id: "weights-layout", run: checkWeightsLayout },
  { id: "round-trip", run: checkRoundTrip },
];

/**
 * Loads a ModelPackage directory, running all nine checks of ADR-003 in order
 * and failing at the first one with a `ModelPackageError` that names it.
 * Never repairs anything.
 */
export function loadModelPackage(dir: string, opts: LoadOptions = {}): LoadedModel {
  const runtime = opts.runtime ?? "ts";
  const state: LoadState = {
    dir,
    wasm: opts.wasm ?? loadWasm(),
    supportedAbis: opts.supportedAbis ?? SUPPORTED_WASM_ABIS,
    warnings: [],
  };
  const reports: CheckReport[] = [];
  const run = (id: CheckId, fn: () => void): void => {
    const info = CHECKS.find((c) => c.id === id) as (typeof CHECKS)[number];
    const t0 = performance.now();
    fn();
    reports.push({ n: info.n, id, title: info.title, durationMs: performance.now() - t0 });
  };

  try {
    for (const c of PIPELINE) run(c.id, () => c.run(state));
    run("golden", () => checkGolden(state, opts.tolerance));
  } catch (e) {
    state.trainer?.free();
    throw e;
  }

  const manifest = state.manifest as ModelPackage;
  const trainer = state.trainer as WasmTrainerApi;
  const predictor = state.predictor as Predictor;
  const dim = manifest.feature_spec.dim;
  const outDim = manifest.network.output_dim;
  let disposed = false;

  const predictBatch = (features: ArrayLike<number>, n: number): Float32Array => {
    if (disposed) throw new Error("model handle was disposed");
    const x = normalizeBatch(manifest.feature_spec, features, n);
    const raw = runtime === "ts" ? predictor.predictLogitsBatch(x, n) : trainer.predictLogitsBatch(x, n);
    return scoreFromLogits(manifest.output_spec, raw, n, outDim);
  };

  return {
    dir,
    modelId: modelId(manifest),
    manifest,
    runtime,
    inputDim: dim,
    outputDim: outDim,
    labels: manifest.output_spec.labels,
    thresholds: manifest.thresholds,
    checks: reports,
    warnings: state.warnings,
    weights: state.weights as Float32Array,
    predictProbs: (features) => predictBatch(features, 1),
    predictBatch,
    oodFeatures: (features) => oodFeatures(manifest.feature_spec, features),
    dispose: () => {
      if (!disposed) trainer.free();
      disposed = true;
    },
  };
}
