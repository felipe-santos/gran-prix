// Regenerates the SYNTHETIC fixtures that exercise every section of the report:
//   test/fixtures/rich-eval-report.json   a valid EvalReport (intrinsic + downstream + gates)
//   test/fixtures/rich-extras.json        the sidecar (CIs, PR curve, D1/D2, gate details, notes)
// Requires the contracts build (`pnpm --filter @gran-prix/contracts build`).
// The numbers are invented for layout purposes; they are not a real evaluation result.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertValid, contractId, sha256Of } from "@gran-prix/contracts";

/** 2-space JSON where leaf objects and arrays of primitives stay on one line (keeps fixtures short). */
const pretty = (v) => {
  const collapse = (m, inner) => (m.length < 260 ? `${m[0]}${inner.replace(/\s*\n\s*/g, " ").trim()}${m[m.length - 1]}`.replace(/^\{ ?/, "{ ").replace(/ ?\}$/, " }") : m);
  return `${JSON.stringify(v, null, 2).replace(/\{[^{}[\]]*\}|\[[^{}[\]]*\]/g, (m) => collapse(m, m.slice(1, -1)))}\n`;
};
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
mkdirSync(out, { recursive: true });

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const prf = ({ tp, fp, tn, fn }) => {
  const p = tp / (tp + fp);
  const r = tp / (tp + fn);
  return { n: tp + fp + tn + fn, tp, fp, tn, fn, precision: r4(p), recall: r4(r), f1: r4((2 * p * r) / (p + r)), accuracy: r4((tp + tn) / (tp + fp + tn + fn)) };
};
const sum = (list) => list.reduce((a, c) => ({ tp: a.tp + c.tp, fp: a.fp + c.fp, tn: a.tn + c.tn, fn: a.fn + c.fn }), { tp: 0, fp: 0, tn: 0, fn: 0 });
const mean = (xs) => xs.reduce((a, c) => a + c, 0) / xs.length;
const id = (s) => sha256Of(`gran-prix-report-fixture:${s}`);

const STRATA = ["article", "product", "listing", "forum", "docs"];
const GROUPS = { article: 30, product: 28, listing: 26, forum: 24, docs: 27 };
const model = {
  article: { tp: 120, fp: 12, tn: 150, fn: 8 },
  product: { tp: 86, fp: 18, tn: 92, fn: 14 },
  listing: { tp: 64, fp: 20, tn: 70, fn: 16 },
  forum: { tp: 58, fp: 16, tn: 62, fn: 14 },
  docs: { tp: 72, fp: 10, tn: 96, fn: 12 },
};
const baselines = {
  readability: {
    article: { tp: 118, fp: 14, tn: 148, fn: 10 },
    product: { tp: 70, fp: 26, tn: 84, fn: 30 },
    listing: { tp: 50, fp: 28, tn: 62, fn: 30 },
    forum: { tp: 44, fp: 24, tn: 54, fn: 28 },
    docs: { tp: 60, fp: 18, tn: 88, fn: 24 },
  },
  trafilatura: {
    article: { tp: 121, fp: 13, tn: 149, fn: 7 },
    product: { tp: 74, fp: 24, tn: 86, fn: 26 },
    listing: { tp: 55, fp: 26, tn: 64, fn: 25 },
    forum: { tp: 49, fp: 22, tn: 56, fn: 23 },
    docs: { tp: 63, fp: 16, tn: 90, fn: 21 },
  },
  "heuristic-v0": {
    article: { tp: 112, fp: 20, tn: 142, fn: 16 },
    product: { tp: 72, fp: 28, tn: 82, fn: 28 },
    listing: { tp: 54, fp: 30, tn: 60, fn: 26 },
    forum: { tp: 46, fp: 26, tn: 52, fn: 26 },
    docs: { tp: 62, fp: 20, tn: 86, fn: 22 },
  },
};

const mAll = sum(Object.values(model));
const by_stratum = Object.fromEntries(STRATA.map((s) => [s, { ...prf(model[s]), n_groups: GROUPS[s] }]));
const baselinesOut = Object.fromEntries(
  Object.entries(baselines).map(([name, per]) => [name, { overall: prf(sum(Object.values(per))), by_stratum: Object.fromEntries(STRATA.map((s) => [s, prf(per[s])])) }]),
);
const comparison = [];
const halfWidth = { article: 0.03, product: 0.06, listing: 0.07, forum: 0.075, docs: 0.055 };
for (const s of STRATA) {
  for (const b of Object.keys(baselines)) {
    const m = by_stratum[s].f1;
    const bv = baselinesOut[b].by_stratum[s].f1;
    const delta = r4(m - bv);
    const h = halfWidth[s] * (b === "trafilatura" ? 1.1 : 1);
    comparison.push({ stratum: s, metric: "f1", model: m, baseline: b, baseline_value: bv, delta: m - bv, ci95: [r4(delta - h), r4(delta + h)], n_groups: GROUPS[s] });
  }
}
// `delta` must equal model - baseline_value up to 1e-9, so keep the unrounded difference.

const groupRows = [];
STRATA.forEach((s, si) => {
  for (let k = 0; k < 3; k++) {
    const f1 = r4(Math.min(0.99, by_stratum[s].f1 + (k - 1) * 0.07 - si * 0.004));
    groupRows.push({ group_id: `g${String(si * 3 + k).padStart(2, "0")}_${s}${k}.example`, stratum: s, f1, kept_ratio: r4(0.08 + 0.05 * si + 0.02 * k) });
  }
});

const labelSource = {
  human: prf(sum(Object.values(model).slice(0, 3))),
  llm: prf(sum(Object.values(model).slice(3))),
};

const report = {
  format: "gran-prix.eval-report",
  format_version: "1.0.0",
  report_id: id("placeholder"),
  mode: "intrinsic",
  model_id: id("model"),
  dataset_id: id("dataset"),
  split: "test",
  threshold: 0.42,
  intrinsic: {
    overall: { ...prf(mAll), auc_roc: 0.941, pr_auc: 0.912, logloss: 0.287, brier: 0.081 },
    by_stratum,
    by_label_source: labelSource,
    baselines: baselinesOut,
    comparison,
    token_stats: { tokenizer: "o200k_base", full_tokens: 1200000, kept_tokens: 104000, ratio: r4(104000 / 1200000) },
    per_group: groupRows,
    calibration: {
      ece: 0.037,
      bins: [
        { lo: 0, hi: 0.2, n: 310, mean_p: 0.08, frac_pos: 0.06 },
        { lo: 0.2, hi: 0.4, n: 140, mean_p: 0.3, frac_pos: 0.27 },
        { lo: 0.4, hi: 0.6, n: 120, mean_p: 0.5, frac_pos: 0.56 },
        { lo: 0.6, hi: 0.8, n: 150, mean_p: 0.71, frac_pos: 0.76 },
        { lo: 0.8, hi: 1, n: 290, mean_p: 0.93, frac_pos: 0.95 },
      ],
    },
  },
  downstream: {
    task_set_id: id("task-set"),
    llm: { model: "answering-llm-placeholder", prompt_sha256: id("prompt") },
    judge: { kind: "llm", model: "judge-llm-placeholder", rubric_sha256: id("rubric") },
    arms: {
      full_page: { n: 500, score_mean: 0.742, score_ci95: [0.702, 0.782], tokens_in_mean: 9800, cost_usd: 41.2 },
      pruned_model: { n: 500, score_mean: 0.716, score_ci95: [0.675, 0.757], tokens_in_mean: 1100, cost_usd: 6.1 },
      pruned_readability: { n: 500, score_mean: 0.668, score_ci95: [0.625, 0.711], tokens_in_mean: 1900, cost_usd: 9.8 },
      closed_book: { n: 500, score_mean: 0.214, score_ci95: [0.178, 0.25], tokens_in_mean: 120, cost_usd: 1.4 },
    },
    paired_deltas: [
      { a: "pruned_model", b: "full_page", mean_delta: -0.026, ci95: [-0.058, 0.006], p_value: 0.11 },
      { a: "pruned_model", b: "pruned_readability", mean_delta: 0.048, ci95: [0.012, 0.084], p_value: 0.009 },
    ],
  },
  gates: [
    { id: "g1_hard_strata_gain", rule: "f1_gain_vs_best_baseline >= 0.05 and ci95_lower > 0", value: 0.081, passed: true },
    { id: "g2_no_article_regression", rule: "article_f1 - best_baseline >= -0.02", value: -0.004, passed: true },
    { id: "g3_downstream_qa", rule: "acc_pruned - acc_full >= -0.05", value: -0.026, passed: true },
    { id: "g4a_tokens_d1", rule: "median_reduction_d1 >= 10", value: 11.5, passed: true },
    { id: "g4b_tokens_d2", rule: "median_reduction_d2 >= 2", value: 1.8, passed: false },
    { id: "g5_runtime_p95_ms", rule: "p95_ms <= 150", value: 112, passed: true },
  ],
  provenance: {
    produced_by: { run_id: "run-0042", stage_id: "eval", kind: "evaluate", impl: "ts:evaluate.intrinsic@1.0.0", params_sha256: id("params"), cache_key: id("cache") },
    inputs: [
      { port: "model", artifact_id: id("model") },
      { port: "dataset", artifact_id: id("dataset") },
    ],
    pipeline_spec_id: id("pipeline"),
    tool_versions: { gp_cli: "0.1.0", node: "v24.13.1", wasm_sha256: id("wasm") },
    created_at: "2026-11-25T12:00:00Z",
    host: "ci-runner",
    duration_ms: 48210,
  },
};
report.report_id = contractId("eval-report", report);
assertValid("eval-report", report);

// PR curve: p(r) = 1 - a r^5 through the operating point, threshold falling linearly with recall.
const opR = report.intrinsic.overall.recall;
const opP = report.intrinsic.overall.precision;
const a = (1 - opP) / opR ** 5;
const points = [];
for (let r = 0.3; r <= 1.0001; r += 0.035) points.push({ r: Math.min(r, 1) });
points.push({ r: opR });
points.sort((x, y) => x.r - y.r);
const pr_points = points.map(({ r }) => ({
  threshold: r4(Math.min(1, Math.max(0, 0.98 - 0.65 * r))),
  precision: r4(r === opR ? opP : 1 - a * r ** 5),
  recall: r4(r),
}));
// Pin the operating point to the report threshold exactly.
const opPoint = pr_points.find((p) => p.recall === r4(opR));
if (opPoint) opPoint.threshold = report.threshold;

const ciOf = (v, h) => [r4(Math.max(0, v - h)), r4(Math.min(1, v + h))];
const cisFor = (p, groups) => {
  const h = 1.6 / Math.sqrt(groups * 4);
  return { precision: ciOf(p.precision, h), recall: ciOf(p.recall, h), f1: ciOf(p.f1, h) };
};
const metric_ci = { model: { overall: cisFor(report.intrinsic.overall, 135) }, baselines: {} };
for (const s of STRATA) metric_ci.model[s] = cisFor(by_stratum[s], GROUPS[s]);
for (const [name, b] of Object.entries(baselinesOut)) {
  metric_ci.baselines[name] = { overall: cisFor(b.overall, 135) };
  for (const s of STRATA) metric_ci.baselines[name][s] = cisFor(b.by_stratum[s], GROUPS[s]);
}

const extras = {
  names: { model: "gp-mlp-v0 (synthetic)", dataset: "dom-v0 test (synthetic)" },
  metric_ci,
  pr_curve: { points: pr_points },
  token_reduction: {
    tokenizer: "o200k_base",
    d1: { full_tokens: 1200000, kept_tokens: 104000, median_ratio: 0.087, iqr_ratio: [0.06, 0.12] },
    d2: { full_tokens: 310000, kept_tokens: 172000, median_ratio: 0.556, iqr_ratio: [0.4, 0.7] },
  },
  gate_details: {
    g1_hard_strata_gain: { name: "G1 Gain on hard strata", threshold: ">= +0.05 F1 over best baseline, CI lower bound > 0", ci95: [0.034, 0.128] },
    g2_no_article_regression: { name: "G2 No regression on articles", threshold: ">= −0.02 F1 (non-inferiority)", ci95: [-0.031, 0.022] },
    g3_downstream_qa: { name: "G3 Downstream QA", threshold: ">= −0.05 accuracy vs full page", ci95: [-0.058, 0.006] },
    g4a_tokens_d1: { name: "G4 Token reduction vs D1 (raw HTML)", threshold: ">= 10× median" },
    g4b_tokens_d2: { name: "G4 Token reduction vs D2 (page markdown)", threshold: ">= 2× median" },
    g5_runtime_p95_ms: { name: "G5 Runtime p95 (ms)", threshold: "<= 150 ms for about 2k nodes" },
  },
  notes: [
    { kind: "note", text: "SYNTHETIC DATA: every number in this fixture is invented to exercise the report layout. It is not a measurement of any model." },
    { kind: "threat", text: "Labeler circularity: the gold labels partly come from an LLM, and baselines that resemble the labeler benefit. See the by-label-source table." },
    { kind: "threat", text: "G4b fails: the reduction over the whole-page markdown (D2) is below 2x, so most of the headline reduction comes from D1." },
  ],
};

// ---- The same synthetic study as a native EvalReport v1.1: no sidecar, every v1.1 field in the report. ----
const v11 = structuredClone(report);
v11.format_version = "1.1.0";
v11.system = { kind: "model", family: "mlp", name: "gp-mlp-v0", version: "0.1.0" };
v11.names = extras.names;
v11.notes = extras.notes;
const I = v11.intrinsic;
I.weighting = { unit: "chars", positive_class: "keep (main + support)", weight_source: "dataset-row.w (own-text chars)" };
I.bootstrap = { resamples: 10000, seed: 20261125, cluster_by: "group_key", method: "percentile", stratified: true };
I.metric_ci = extras.metric_ci;
I.pr_curve = {
  points: [...extras.pr_curve.points].sort((a, b) => a.threshold - b.threshold),
  operating_threshold: report.threshold,
  operating_rule: "max threshold with char-weighted recall >= 0.85 on dev OOF (synthetic)",
};
const coverage = { readability: 0.99, trafilatura: 0.94, "heuristic-v0": 1 };
for (const [name, cov] of Object.entries(coverage)) I.baselines[name].coverage = cov;
const tagStrata = { "lang:en": ["article", "product", "listing"], "lang:pt": ["forum", "docs"], logged_in: ["forum", "product"] };
I.by_tag = Object.fromEntries(Object.entries(tagStrata).map(([t, ss]) => [t, { ...prf(sum(ss.map((s) => model[s]))), n_groups: ss.reduce((a, s) => a + GROUPS[s], 0) }]));
const hard = ["listing", "forum", "docs"];
const hardMicro = prf(sum(hard.map((s) => model[s])));
const hardBase = prf(sum(hard.map((s) => baselines.trafilatura[s])));
const macroPage = r4(0.5 * hardMicro.f1 + 0.5 * mean(hard.map((s) => by_stratum[s].f1)));
const macroStratum = r4(mean(hard.map((s) => by_stratum[s].f1)));
I.aggregates = [{ name: "hard", strata: hard, micro: hardMicro, macro_page_f1: macroPage, macro_stratum_f1: macroStratum, ci95: [0.74, 0.86] }];
for (const e of I.comparison) e.aggregation = "macro_page";
const extraCmp = (stratum, metric, model_, base, ci, n_groups, aggregation) => ({ stratum, metric, model: model_, baseline: "trafilatura", baseline_value: base, delta: model_ - base, ci95: ci, n_groups, ...(aggregation ? { aggregation } : {}) });
I.comparison.push(
  extraCmp("hard", "f1", macroPage, r4(hardBase.f1), [0.052, 0.128], 77, "macro_page"),
  extraCmp("hard", "recall", hardMicro.recall, hardBase.recall, [0.03, 0.15], 77, "micro"),
  extraCmp("article", "token_f1", 0.83, 0.8, [-0.02, 0.08], GROUPS.article),
);
I.token_reduction = {
  tokenizer: "o200k_base",
  converter: "turndown@7.2.0+gfm",
  d1: {
    full_tokens: 1200000, kept_tokens: 104000, n_pages: 135, median_ratio: 0.087, iqr_ratio: [0.06, 0.12], median_reduction: 11.5, iqr_reduction: [8.3, 16.7], pooled_ratio: r4(104000 / 1200000),
    by_stratum: { article: { n_pages: 30, median_ratio: 0.05, median_reduction: 20 }, docs: { n_pages: 27, median_ratio: 0.11, median_reduction: 9.1 } },
    description: "rendered outerHTML after settle, data-gp-* stripped",
  },
  d2: {
    full_tokens: 310000, kept_tokens: 172000, n_pages: 135, median_ratio: 0.556, iqr_ratio: [0.4, 0.7], median_reduction: 1.8, iqr_reduction: [1.4, 2.5], pooled_ratio: r4(172000 / 310000),
    by_stratum: { article: { n_pages: 30, median_ratio: 0.31, median_reduction: 3.2 }, docs: { n_pages: 27, median_ratio: 0.7, median_reduction: 1.4 } },
  },
};
I.runtime = { p95_ms: 112.4, model_bytes: 84000, n_pages: 135, p50_ms: 58.2, cpu_throttle: 4, repetitions: 5, environment: "chromium-headless 130, 4x CPU throttle", page_elements: [800, 2400] };
I.per_group.forEach((g, k) => {
  g.group_key = `${g.group_id.split("_")[1]}`;
  g.n_chars = 2000 + 350 * k;
});
v11.downstream.bootstrap = I.bootstrap;
v11.downstream.judge.human_agreement = 0.87;
v11.downstream.arms.full_page.evidence_retention = { mean: 1, n_questions: 500 };
v11.downstream.arms.pruned_model.evidence_retention = { mean: 0.93, ci95: [0.9, 0.96], n_questions: 500, token_fraction_mean: 0.11 };
v11.downstream.arms.pruned_readability.evidence_retention = { mean: 0.88, ci95: [0.84, 0.92], n_questions: 500 };
const gate = (id, name, rule, g) => ({ id, name, rule, ...g });
v11.gates = [
  gate("g1_hard_strata_gain", "G1 Gain on hard strata", "macro-page F1(model) - F1(best baseline) >= 0.05 on hard, decided on the CI lower bound", {
    value: 0.052, passed: true, comparator: ">=", threshold: 0.05, unit: "f1", stratum: "hard", observed: 0.081, ci95: [0.052, 0.128], use_ci_lower: true, metric: "f1", baseline: "trafilatura", aggregation: "macro_page",
  }),
  gate("g2_no_article_regression", "G2 No regression on articles", "article F1 - best baseline >= -0.02 (non-inferiority, point estimate)", {
    value: -0.004, passed: true, comparator: ">=", threshold: -0.02, unit: "f1", stratum: "article", observed: -0.004, ci95: [-0.031, 0.022], metric: "f1", baseline: "trafilatura", aggregation: "macro_page",
  }),
  gate("g3_downstream_qa", "G3 Downstream QA", "accuracy(pruned) - accuracy(full page) >= -5 pp", {
    value: -2.6, passed: true, comparator: ">=", threshold: -5, unit: "pp", observed: -2.6, ci95: [-5.8, 0.6], metric: "qa_accuracy",
  }),
  gate("g4a_tokens_d1", "G4 Token reduction vs D1 (raw HTML)", "median per-page tok(D1)/tok(output) >= 10x", { value: 11.5, passed: true, comparator: ">=", threshold: 10, unit: "x", observed: 11.5, metric: "token_reduction_d1" }),
  gate("g4b_tokens_d2", "G4 Token reduction vs D2 (page markdown)", "median per-page tok(D2)/tok(output) >= 2x", { value: 1.8, passed: false, comparator: ">=", threshold: 2, unit: "x", observed: 1.8, metric: "token_reduction_d2" }),
  gate("g5_runtime_p95_ms", "G5 Runtime p95", "p95 <= 150 ms for about 2k nodes", { value: 112.4, passed: true, comparator: "<=", threshold: 150, unit: "ms", observed: 112.4, metric: "p95_ms" }),
  gate("g5b_model_size", "G5 Model size", "model bytes <= 256 KiB", { value: 84000, passed: true, comparator: "<=", threshold: 262144, unit: "bytes", observed: 84000, metric: "model_bytes" }),
];
v11.report_id = contractId("eval-report", v11);
assertValid("eval-report", v11);

writeFileSync(join(out, "rich-eval-report.json"), pretty(report));
writeFileSync(join(out, "rich-extras.json"), pretty(extras));
writeFileSync(join(out, "rich-eval-report-v11.json"), pretty(v11));
console.log("wrote rich-eval-report.json, rich-extras.json (v1.0 + sidecar) and rich-eval-report-v11.json (native v1.1)", report.report_id, v11.report_id);
