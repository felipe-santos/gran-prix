import type { ModelPackage } from "@gran-prix/contracts";

type FeatureSpec = ModelPackage["feature_spec"];
type OutputSpec = ModelPackage["output_spec"];

/**
 * Normalization of `feature_spec` (README of the contracts): z-score is
 * `x' = (x - mean) / (std + eps)`, applied to the extractor output before the
 * network. Input is `n` row-major samples of `dim` extractor values.
 */
export function normalizeBatch(spec: FeatureSpec, inputs: ArrayLike<number>, n: number): Float32Array {
  const dim = spec.dim;
  if (inputs.length !== n * dim) {
    throw new RangeError(`expected ${n} x ${dim} = ${n * dim} feature values, got ${inputs.length}`);
  }
  const out = new Float32Array(n * dim);
  const norm = spec.normalization;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < dim; c++) {
      const x = inputs[r * dim + c] as number;
      if (!Number.isFinite(x)) throw new RangeError(`feature ${c} (${spec.names[c] ?? "?"}) of row ${r} is not finite`);
      out[r * dim + c] =
        norm.kind === "zscore" ? (x - (norm.mean[c] as number)) / ((norm.std[c] as number) + norm.eps) : x;
    }
  }
  return out;
}

/** Indices of the features of ONE sample that fall outside `feature_spec.ood` (range widened by its tolerance). */
export function oodFeatures(spec: FeatureSpec, input: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let c = 0; c < spec.dim; c++) {
    const lo = spec.ood.lo[c] as number;
    const hi = spec.ood.hi[c] as number;
    const slack = (hi - lo) * spec.ood.tolerance;
    const x = input[c] as number;
    if (!(x >= lo - slack && x <= hi + slack)) out.push(c);
  }
  return out;
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

function softmaxRow(z: Float64Array): void {
  let max = -Infinity;
  for (const v of z) max = Math.max(max, v);
  let sum = 0;
  for (let i = 0; i < z.length; i++) {
    z[i] = Math.exp((z[i] as number) - max);
    sum += z[i] as number;
  }
  for (let i = 0; i < z.length; i++) z[i] = (z[i] as number) / sum;
}

/**
 * Final model output from raw network outputs (logits): calibration acts on
 * the logit, then the activation of `output_spec` (README of the contracts).
 * `raw` holds `n * outputDim` values.
 */
export function scoreFromLogits(spec: OutputSpec, raw: ArrayLike<number>, n: number, outputDim: number): Float32Array {
  const out = new Float32Array(n * outputDim);
  const cal = spec.calibration;
  for (let r = 0; r < n; r++) {
    const row = new Float64Array(outputDim);
    for (let k = 0; k < outputDim; k++) row[k] = raw[r * outputDim + k] as number;
    if (spec.activation === "sigmoid") {
      const z = cal.kind === "platt" ? cal.a * (row[0] as number) + cal.b : (row[0] as number);
      row[0] = sigmoid(z);
    } else {
      if (cal.kind === "temperature") for (let k = 0; k < outputDim; k++) row[k] = (row[k] as number) / cal.t;
      if (spec.activation === "softmax") softmaxRow(row);
    }
    out.set(row, r * outputDim);
  }
  return out;
}

const P_MIN = 1e-30;

/**
 * Same final output from the probabilities the WASM Trainer returns (it
 * exposes no raw logits): sigmoid / softmax are inverted (logit, log p; the
 * additive constant of softmax cancels), calibrated, and re-activated.
 * Without calibration the WASM output is returned as is. WASM cannot express
 * the `identity` activation: callers must not use this for it.
 */
export function scoreFromProbs(spec: OutputSpec, probs: ArrayLike<number>, n: number, outputDim: number): Float32Array {
  const cal = spec.calibration;
  if (cal.kind === "none") return Float32Array.from(probs as ArrayLike<number> & Iterable<number>);
  const logits = new Float64Array(n * outputDim);
  for (let i = 0; i < logits.length; i++) {
    const p = Math.min(Math.max(probs[i] as number, P_MIN), 1 - 1e-16);
    logits[i] = spec.activation === "sigmoid" ? Math.log(p / (1 - p)) : Math.log(p);
  }
  return scoreFromLogits(spec, logits, n, outputDim);
}
