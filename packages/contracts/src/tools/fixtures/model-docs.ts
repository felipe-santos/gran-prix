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

export function buildProvenance(stage: string, kind: string, impl: string, toolSha?: Sha256): Provenance {
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
    tool_versions: { gp_cli: "0.1.0", node: "v24.13.1", wasm_sha256: sha("wasm"), ...(toolSha ? { tool_sha256: toolSha } : {}) },
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
    format_version: "1.1.0",
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
    provenance: buildProvenance("train", "train", "rust:train.gp-train@1.0.0", sha("gp-train-binary")),
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
  const ciDelta: [number, number] = [delta - 0.1, delta + 0.1];
  const hardF1 = 0.8;
  const hardBase = 0.7;
  const doc: EvalReport = {
    format: "gran-prix.eval-report",
    format_version: "1.1.0",
    report_id: sha("placeholder"),
    mode: "intrinsic",
    model_id: model.model_id,
    dataset_id: datasetId,
    split: "test",
    threshold: 0.5,
    system: { kind: "model", family: "mlp", name: "gp-mlp-fixture", version: "0.1.0" },
    names: { model: "gp-mlp-fixture (synthetic)", dataset: "fixture dataset (synthetic)" },
    bootstrap: { resamples: 10000, seed: 20261125, cluster_by: "group_key", method: "percentile", stratified: true },
    intrinsic: {
      weighting: "chars",
      overall: { ...overall, auc_roc: 0.93, pr_auc: 0.9, logloss: 0.31, brier: 0.09 },
      by_stratum: { article: { ...article, n_groups: 3 }, docs: { ...docs, n_groups: 2 } },
      by_label_source: { human: prf(8, 2, 9, 1) },
      by_tag: { "lang:en": { ...prf(5, 1, 5, 0), n_groups: 3 }, logged_in: { ...prf(3, 1, 4, 1), n_groups: 2 } },
      baselines: {
        readability: {
          overall: readability,
          by_stratum: { article: { ...baseArticle, n_groups: 3 }, docs: { ...baseDocs, n_groups: 2 } },
        },
      },
      aggregates: [{ name: "hard", strata: ["docs"], macro_page_f1: 0.72, macro_stratum_f1: 0.75, ci95: [0.55, 0.88] }],
      comparison: [
        { stratum: "article", metric: "f1", model: article.f1, baseline: "readability", baseline_value: baseArticle.f1, delta, ci95: ciDelta, n_groups: 3 },
        { stratum: "article", metric: "recall", model: article.recall, baseline: "readability", baseline_value: baseArticle.recall, delta: article.recall - baseArticle.recall, ci95: [0.0, 0.4], n_groups: 3 },
        { stratum: "hard", metric: "token_f1", model: hardF1, baseline: "readability", baseline_value: hardBase, delta: hardF1 - hardBase, ci95: [-0.05, 0.25], n_groups: 2 },
      ],
      metric_ci: {
        model: {
          overall: { precision: [0.55, 0.95], recall: [0.6, 0.99], f1: [0.6, 0.96] },
          article: { f1: [0.7, 1] },
          docs: { f1: [0.3, 0.95] },
        },
        baselines: { readability: { overall: { f1: [0.45, 0.85] } } },
      },
      pr_curve: {
        points: [
          { threshold: 0.1, precision: 0.6, recall: 0.99 },
          { threshold: 0.3, precision: 0.75, recall: 0.95 },
          { threshold: 0.5, precision: 0.8, recall: 0.8889 },
          { threshold: 0.7, precision: 0.9, recall: 0.7 },
          { threshold: 0.9, precision: 1, recall: 0.4 },
        ],
        operating_threshold: 0.5,
        operating_rule: "max threshold with char-weighted recall >= 0.85 on dev (fixture value)",
      },
      token_stats: { tokenizer: "o200k_base", full_tokens: 52000, kept_tokens: 9100, ratio: 9100 / 52000 },
      token_reduction: {
        tokenizer: "cl100k_base",
        converter: "turndown@7.2.0+gfm",
        d1: {
          full_tokens: 520000,
          kept_tokens: 9100,
          n_pages: 5,
          median_ratio: 0.02,
          iqr_ratio: [0.012, 0.03],
          median_reduction: 50,
          iqr_reduction: [33.3, 83.3],
          pooled_ratio: 0.0175,
          by_stratum: { article: { n_pages: 3, median_ratio: 0.018, median_reduction: 55.5 }, docs: { n_pages: 2, median_ratio: 0.03, median_reduction: 33.3 } },
          description: "rendered outerHTML after settle, data-gp-* stripped",
        },
        d2: {
          full_tokens: 52000,
          kept_tokens: 9100,
          n_pages: 5,
          median_ratio: 0.4,
          iqr_ratio: [0.3, 0.5],
          median_reduction: 2.5,
          iqr_reduction: [2, 3.3],
          pooled_ratio: 0.175,
          by_stratum: { article: { n_pages: 3, median_ratio: 0.38, median_reduction: 2.6 }, docs: { n_pages: 2, median_ratio: 0.45, median_reduction: 2.2 } },
        },
      },
      runtime: { p95_ms: 112.4, model_bytes: 84000, n_pages: 22, p50_ms: 61, cpu_throttle: 4, repetitions: 3, environment: "chromium-headless, 4x CPU throttle", page_elements: [1500, 3000] },
      per_group: [
        {
          group_id: "g00_site0", stratum: "article", f1: 0.9, kept_ratio: 0.2, group_key: "site0.example", n_chars: 4200,
          f1_by_baseline: { readability: 0.7 }, tokens_d1: 31000, tokens_d2: 5200, tokens_kept: 900,
        },
        { group_id: "g01_site1", stratum: "docs", f1: 0.7, kept_ratio: 0.35 },
      ],
      calibration: { ece: 0.04, bins: [{ lo: 0, hi: 0.5, n: 10, mean_p: 0.2, frac_pos: 0.1 }, { lo: 0.5, hi: 1, n: 10, mean_p: 0.8, frac_pos: 0.9 }] },
    },
    gates: [
      {
        id: "g1a_f1_article", name: "G1a F1 gain over the best baseline", rule: "F1(model) - F1(readability) > 0 on article, decided on the CI lower bound",
        value: ciDelta[0], passed: ciDelta[0] > 0, comparator: ">", threshold: 0, unit: "f1", stratum: "article", observed: delta, ci95: ciDelta, use_ci_lower: true,
      },
      {
        id: "g4_token_reduction_d2", name: "G4 token reduction vs full-page markdown", rule: "median per-page tok(D2)/tok(output) >= 2x",
        value: 2.5, passed: true, comparator: ">=", threshold: 2, unit: "x", stratum: "overall", observed: 2.5,
      },
      {
        id: "g5_p95_latency", name: "G5 p95 latency", rule: "p95 <= 150 ms", value: 112.4, passed: true, comparator: "<=", threshold: 150, unit: "ms", observed: 112.4,
      },
      // A v1.0-style gate (no structured fields) stays valid.
      { id: "f1_vs_readability", rule: "macro_f1_delta >= 0", value: delta, passed: delta >= 0 },
    ],
    notes: [
      { kind: "note", text: "Synthetic report: every number is invented to exercise the contract." },
      { kind: "threat", text: "Baselines tuned with the same budget as the model; a stronger baseline could change the comparison." },
    ],
    provenance: buildProvenance("eval", "evaluate", "ts:evaluate.intrinsic@1.0.0"),
  };
  return { ...doc, report_id: contractId("eval-report", doc) };
}

/** A downstream (QA) report: arms with evidence retention, paired deltas, structured gates. */
export function buildDownstreamReport(model: ModelPackage, datasetId: Sha256, taskSetId: Sha256): EvalReport {
  const doc: EvalReport = {
    format: "gran-prix.eval-report",
    format_version: "1.1.0",
    report_id: sha("placeholder"),
    mode: "downstream",
    model_id: model.model_id,
    dataset_id: datasetId,
    split: "test",
    threshold: 0.5,
    system: { kind: "model", family: "mlp", name: "gp-mlp-fixture", version: "0.1.0" },
    bootstrap: { resamples: 10000, seed: 20261125, cluster_by: "group_key", method: "percentile", stratified: false },
    downstream: {
      task_set_id: taskSetId,
      llm: { model: "respondent-r1", prompt_sha256: sha("qa-prompt") },
      judge: { kind: "llm", model: "judge-mid", rubric_sha256: sha("rubric"), human_agreement: 0.93 },
      arms: {
        full_page: { n: 4, score_mean: 0.75, score_ci95: [0.4, 1], tokens_in_mean: 5200, cost_usd: 0.04 },
        pruned_model: {
          n: 4, score_mean: 0.75, score_ci95: [0.4, 1], tokens_in_mean: 900, cost_usd: 0.01,
          evidence_retention: { mean: 0.96, ci95: [0.8, 1], n_questions: 4, token_fraction_mean: 0.98, by_stratum: { article: { mean: 1, n_questions: 3 }, docs: { mean: 0.8, n_questions: 1 } } },
        },
        oracle: { n: 4, score_mean: 1, score_ci95: [0.6, 1], tokens_in_mean: 800, cost_usd: 0.01, evidence_retention: { mean: 1, n_questions: 4 } },
      },
      paired_deltas: [{ a: "pruned_model", b: "full_page", mean_delta: 0, ci95: [-0.2, 0.2], p_value: 1 }],
    },
    gates: [
      {
        id: "g3_qa_accuracy_r1", name: "G3 QA accuracy loss (R1)", rule: "CI lower bound of the paired accuracy delta >= -0.05",
        value: -0.2, passed: false, comparator: ">=", threshold: -0.05, unit: "accuracy", stratum: "overall", observed: 0, ci95: [-0.2, 0.2], use_ci_lower: true,
      },
      { id: "g3_evidence_retention", name: "G3 evidence retention", rule: "retention >= 95%", value: 0.96, passed: true, comparator: ">=", threshold: 0.95, unit: "ratio", observed: 0.96 },
    ],
    provenance: buildProvenance("qa", "evaluate", "ts:evaluate.downstream@1.0.0"),
  };
  return { ...doc, report_id: contractId("eval-report", doc) };
}
