/** Synthetic fixture documents for ModelPackage, golden.json and EvalReport. */
import type { EvalReport, Prf } from "../../eval-report.js";
import type { FeatureSchema } from "../../feature-schema.js";
import type { Golden } from "../../golden.js";
import { contractId, modelId } from "../../identity/contract-ids.js";
import { artifactId, sha256Of, type Sha256 } from "../../identity/hash.js";
import type { ModelPackage } from "../../model-package.js";
import type { Provenance } from "../../provenance.js";
import { FEATURE_ROWS, sha } from "./extract-docs.js";
import { NETWORK_DEF } from "./data-docs.js";

const f32 = Math.fround;

export function buildProvenance(stage: string, kind: string, impl: string): Provenance {
  return {
    produced_by: {
      run_id: "run-0001",
      stage_id: stage,
      kind,
      impl,
      params_sha256: artifactId({ stage }),
      cache_key: sha(`cache:${stage}`),
    },
    inputs: [{ port: "dataset", artifact_id: sha("dataset-input") }],
    pipeline_spec_id: sha("pipeline-spec"),
    tool_versions: { gp_cli: "0.1.0", node: "v24.13.1", wasm_sha256: sha("wasm") },
    created_at: "2026-11-25T12:00:00Z",
    duration_ms: 1234,
  };
}

/** Deterministic float32 weights: 4x3 + 3 + 3x1 + 1 = 19 values. */
export function buildWeights(): { values: number[]; bytes: Uint8Array } {
  const values = Array.from({ length: 19 }, (_, k) => f32(Math.sin(k + 1) / 2));
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, k) => buf.writeFloatLE(v, k * 4));
  return { values, bytes: new Uint8Array(buf) };
}

const MEAN = [0.5, 0.3, 0.3, 0.1];
const STD = [0.2, 0.4, 0.5, 0.05];
const EPS = 1e-6;

/** Reference forward pass of the fixture network: z-score -> linear -> relu -> linear (logit) -> sigmoid. */
function forward(w: number[], x: number[]): { raw: number; score: number } {
  const z = x.map((v, i) => (v - (MEAN[i] as number)) / ((STD[i] as number) + EPS));
  const h = [0, 1, 2].map((j) => {
    let s = w[12 + j] as number; // layers[0].bias
    for (let i = 0; i < 4; i++) s += (z[i] as number) * (w[i * 3 + j] as number); // layers[0].weight [4,3]
    return Math.max(0, s);
  });
  let raw = w[18] as number; // layers[2].bias
  for (let j = 0; j < 3; j++) raw += (h[j] as number) * (w[15 + j] as number); // layers[2].weight [3,1]
  return { raw, score: 1 / (1 + Math.exp(-raw)) };
}

export function buildGolden(weightsSha: Sha256, weights: number[]): Golden {
  return {
    format: "gran-prix.golden",
    format_version: "1.0.0",
    weights_sha256: weightsSha,
    tolerance: { abs: 1e-5 },
    cases: FEATURE_ROWS.map((x, i) => {
      const { raw, score } = forward(weights, x);
      return { name: `row${i}`, input: x, raw: [f32(raw)], score: [f32(score)] };
    }),
  };
}

export interface ModelFixture {
  model: ModelPackage;
  networkDefText: string;
  weightsBytes: Uint8Array;
  goldenText: string;
  golden: Golden;
}

export function buildModel(schema: FeatureSchema): ModelFixture {
  const { values, bytes } = buildWeights();
  const weightsSha = sha256Of(bytes);
  const golden = buildGolden(weightsSha, values);
  const goldenText = `${JSON.stringify(golden, null, 2)}\n`;
  const networkDefText = JSON.stringify(NETWORK_DEF);

  const model: ModelPackage = {
    format: "gran-prix.model-package",
    format_version: "1.0.0",
    model_id: sha("placeholder"),
    name: "dom-fixture-model",
    description: "Tiny model used only by the contract fixtures.",
    task: { name: "dom-content-classifier", unit: schema.unit, stateless: true },
    files: {
      network_def: { path: "network_def.json", bytes: Buffer.byteLength(networkDefText) },
      weights: { path: "weights.f32le", bytes: bytes.byteLength, dtype: "f32le", count: values.length },
      golden: { path: "golden.json", bytes: Buffer.byteLength(goldenText) },
    },
    digest: {
      algorithm: "sha256",
      network_def: artifactId(NETWORK_DEF),
      weights: weightsSha,
      golden: sha256Of(goldenText),
    },
    network: {
      input_dim: 4,
      output_dim: 1,
      param_layout: [
        { name: "layers[0].weight", shape: [4, 3], offset: 0, length: 12 },
        { name: "layers[0].bias", shape: [1, 3], offset: 12, length: 3 },
        { name: "layers[2].weight", shape: [3, 1], offset: 15, length: 3 },
        { name: "layers[2].bias", shape: [1, 1], offset: 18, length: 1 },
      ],
    },
    feature_spec: {
      schema_id: schema.schema_id,
      name: schema.name,
      version: schema.version,
      dim: schema.dim,
      names: schema.features.map((f) => f.name),
      normalization: { kind: "zscore", mean: MEAN, std: STD, eps: EPS },
      ood: { lo: [0, 0, 0, 0], hi: [1, 1, 1, 0.5], tolerance: 0.1 },
    },
    output_spec: { activation: "sigmoid", labels: ["drop", "keep"], calibration: { kind: "platt", a: 1.0, b: 0.0 } },
    thresholds: { accept: 0.7, escalate: 0.4, margin: 0.1 },
    requires: { runtime: { wasm_abi: "gran-prix-wasm@0.1" }, layer_types: ["linear", "activation"], extensions: [] },
    provenance: buildProvenance("train", "train", "ts:train.wasm-trainer@1.0.0"),
  };
  model.model_id = modelId(model);
  return { model, networkDefText, weightsBytes: bytes, goldenText, golden };
}

export function prf(tp: number, fp: number, tn: number, fn: number): Prf {
  const n = tp + fp + tn + fn;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { n, tp, fp, tn, fn, precision, recall, f1, accuracy: n === 0 ? 0 : (tp + tn) / n };
}

export function buildEvalReport(model: ModelPackage, datasetId: Sha256): EvalReport {
  const overall = prf(8, 2, 9, 1);
  const article = prf(5, 1, 5, 0);
  const docs = prf(3, 1, 4, 1);
  const readability = prf(7, 3, 8, 2);
  const baseArticle = prf(4, 2, 4, 1);
  const baseDocs = prf(3, 1, 4, 1);
  const delta = article.f1 - baseArticle.f1;
  const doc: EvalReport = {
    format: "gran-prix.eval-report",
    format_version: "1.0.0",
    report_id: sha("placeholder"),
    mode: "intrinsic",
    model_id: model.model_id,
    dataset_id: datasetId,
    split: "test",
    threshold: 0.5,
    intrinsic: {
      overall: { ...overall, auc_roc: 0.93, pr_auc: 0.9, logloss: 0.31, brier: 0.09 },
      by_stratum: { article: { ...article, n_groups: 3 }, docs: { ...docs, n_groups: 2 } },
      by_label_source: { human: prf(8, 2, 9, 1) },
      baselines: { readability: { overall: readability, by_stratum: { article: baseArticle, docs: baseDocs } } },
      comparison: [
        { stratum: "article", metric: "f1", model: article.f1, baseline: "readability", baseline_value: baseArticle.f1, delta, ci95: [delta - 0.1, delta + 0.1], n_groups: 3 },
      ],
      token_stats: { tokenizer: "o200k_base", full_tokens: 52000, kept_tokens: 9100, ratio: 9100 / 52000 },
      per_group: [
        { group_id: "g00_site0", stratum: "article", f1: 0.9, kept_ratio: 0.2 },
        { group_id: "g01_site1", stratum: "docs", f1: 0.7, kept_ratio: 0.35 },
      ],
      calibration: { ece: 0.04, bins: [{ lo: 0, hi: 0.5, n: 10, mean_p: 0.2, frac_pos: 0.1 }, { lo: 0.5, hi: 1, n: 10, mean_p: 0.8, frac_pos: 0.9 }] },
    },
    gates: [{ id: "f1_vs_readability", rule: "macro_f1_delta >= 0", value: delta, passed: delta >= 0 }],
    provenance: buildProvenance("eval", "evaluate", "ts:evaluate.intrinsic@1.0.0"),
  };
  return { ...doc, report_id: contractId("eval-report", doc) };
}
