import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactId, modelId, sha256Of, type Golden, type ModelPackage, type Sha256 } from "@gran-prix/contracts";
import { createPredictor, paramLayout, parseNetworkDef, type NetworkDef } from "@gran-prix/infer-ts";
import { normalizeBatch, scoreFromLogits } from "@gran-prix/model";

/**
 * A ModelPackage with random (seeded) weights and the architecture of your choice, to measure what a network of
 * that size costs without waiting for a trained one: the worst case of the `train.cv` grid is `[64, 32]` over the 59
 * features of FeatureSchema v0. It passes the nine checks of `loadModelPackage` (the golden vectors come from the
 * TypeScript interpreter), but it has NO predictive value and must never be reported as a model.
 */

export interface SyntheticModelOptions {
  /** The `FeatureSchema` the model reads: only `schema_id`, `name`, `version`, `dim`, `unit` and each feature's `name` and `range` are used. */
  schema: {
    schema_id: Sha256;
    name: string;
    version: `${number}.${number}.${number}`;
    unit: string;
    dim: number;
    features: ReadonlyArray<{ name: string; range: readonly [number, number] }>;
  };
  /** Hidden layer widths, e.g. `[64, 32]`. */
  hidden: readonly number[];
  seed?: number;
  /** Golden cases (default 6). */
  goldenCases?: number;
}

export type PackageFiles = Record<"model.json" | "network_def.json" | "weights.f32le" | "golden.json", Uint8Array | string>;

/** mulberry32: a small, well-known 32-bit PRNG, so the weights are the same on every machine. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gauss = (u: () => number): number => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());

export function buildSyntheticModel(o: SyntheticModelOptions): PackageFiles {
  const dim = o.schema.dim;
  if (o.schema.features.length !== dim) throw new Error(`schema.dim ${dim} != ${o.schema.features.length} features`);
  const u = prng(o.seed ?? 1);
  const widths = [dim, ...o.hidden, 1];
  const layers: NetworkDef["layers"] = [];
  widths.slice(0, -1).forEach((w, i) => {
    layers.push({ type: "linear", in_features: w, out_features: widths[i + 1] as number });
    if (i < widths.length - 2) layers.push({ type: "activation", function: "relu" });
  });
  const def = { input_dim: dim, layers };
  const defText = JSON.stringify(def);
  const layout = paramLayout(parseNetworkDef(def));
  const count = layout.reduce((n, p) => n + p.len, 0);
  const weights = new Float32Array(count);
  for (const p of layout) {
    // He-normal weights keep the activations in range through the ReLU layers; biases start at zero.
    const std = p.name.endsWith(".weight") ? Math.sqrt(2 / (p.shape[0] as number)) : 0;
    for (let i = 0; i < p.len; i++) weights[p.offset + i] = std === 0 ? 0 : gauss(u) * std;
  }
  const weightBytes = new Uint8Array(weights.buffer.slice(0));
  const weightsSha = sha256Of(weightBytes);

  const lo = o.schema.features.map((f) => f.range[0]);
  const hi = o.schema.features.map((f) => f.range[1]);
  const mean = lo.map((v, i) => (v + (hi[i] as number)) / 2);
  const std = lo.map((v, i) => Math.max(((hi[i] as number) - v) / 4, 1e-3));
  const feature_spec: ModelPackage["feature_spec"] = {
    schema_id: o.schema.schema_id,
    name: o.schema.name,
    version: o.schema.version,
    dim,
    names: o.schema.features.map((f) => f.name),
    normalization: { kind: "zscore", mean, std, eps: 1e-6 },
    ood: { lo, hi, tolerance: 0.1 },
  };
  const output_spec: ModelPackage["output_spec"] = { activation: "sigmoid", labels: ["drop", "keep"], calibration: { kind: "platt", a: 1, b: 0 } };

  // Golden: inputs spread inside the feature ranges, outputs from the TypeScript interpreter + the Node scoring path.
  const nCases = o.goldenCases ?? 6;
  const inputs: number[][] = Array.from({ length: nCases }, () => lo.map((v, i) => Math.fround(v + u() * ((hi[i] as number) - v))));
  const flat = Float32Array.from(inputs.flat());
  const norm = normalizeBatch(feature_spec, flat, nCases);
  const raw = createPredictor(def, weights, { head: "sigmoid" }).predictLogitsBatch(norm, nCases);
  const score = scoreFromLogits(output_spec, raw, nCases, 1);
  const golden: Golden = {
    format: "gran-prix.golden",
    format_version: "1.0.0",
    weights_sha256: weightsSha,
    tolerance: { abs: 1e-5 },
    cases: inputs.map((input, i) => ({ name: `case${i}`, input, raw: [raw[i] as number], score: [score[i] as number] })),
  };
  const goldenText = `${JSON.stringify(golden, null, 2)}\n`;

  const zero = `sha256:${"0".repeat(64)}` as Sha256;
  const model: ModelPackage = {
    format: "gran-prix.model-package",
    format_version: "1.1.0",
    model_id: zero,
    name: `synthetic-mlp-${widths.join("x")}`,
    description: "Random weights of a given architecture, for latency and size measurements only. Not a trained model.",
    task: { name: "dom-content-classifier", unit: o.schema.unit, stateless: true },
    files: {
      network_def: { path: "network_def.json", bytes: Buffer.byteLength(defText) },
      weights: { path: "weights.f32le", bytes: weightBytes.byteLength, dtype: "f32le", count },
      golden: { path: "golden.json", bytes: Buffer.byteLength(goldenText) },
    },
    digest: { algorithm: "sha256", network_def: artifactId(def), weights: weightsSha, golden: sha256Of(goldenText) },
    network: {
      input_dim: dim,
      output_dim: 1,
      param_layout: layout.map((p) => ({ name: p.name, shape: p.shape, offset: p.offset, length: p.len })),
    },
    feature_spec,
    output_spec,
    thresholds: { accept: 0.7, escalate: 0.4, margin: 0.1 },
    requires: { runtime: { wasm_abi: "gran-prix-wasm@0.1" }, layer_types: ["linear", "activation"], extensions: [] },
    provenance: {
      produced_by: { run_id: "synthetic", stage_id: "synthetic", kind: "train", impl: "ts:synthetic-model@1.0.0", params_sha256: artifactId({ hidden: [...o.hidden], seed: o.seed ?? 1 }), cache_key: zero },
      inputs: [],
      pipeline_spec_id: zero,
      tool_versions: { gp_cli: "0.1.0", node: process.version },
      created_at: "2026-11-25T00:00:00Z",
      duration_ms: 0,
      placeholder: true,
    },
  };
  model.model_id = modelId(model);
  return { "model.json": `${JSON.stringify(model, null, 2)}\n`, "network_def.json": defText, "weights.f32le": weightBytes, "golden.json": goldenText };
}

/** Writes the files of a package into `dir` (created if missing). */
export function writeModelPackage(dir: string, files: PackageFiles): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
}
