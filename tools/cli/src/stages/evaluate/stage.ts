import { artifactId, assertValid, contractId, stageCacheKey, type EvalReport, type Sha256 } from "@gran-prix/contracts";
import { wasmSha256, type Runtime } from "@gran-prix/model";
import type { ReportExtras } from "@gran-prix/report";
import { defineStage, type StageContext } from "../../stage.js";
import type { ArtifactHandle } from "../../store.js";
import { GP_VERSION } from "../../version.js";
import { evaluateCore, type BaselineInput, type CoreOptions, type GroupInfo, type ScoredRow } from "./core.js";
import { GATE_PARAM_SCHEMA, type GateParam } from "./gates.js";
import { readBaseline, readDataset, readModel, scoreRows, type DataRow, type SplitParam } from "./load.js";

/**
 * `ts:evaluate.intrinsic@1.0.0`: scores a split of a Dataset with a ModelPackage and writes an
 * EvalReport v1.0 (element-level, character-weighted, positive = keep, per stratum and overall),
 * the extras sidecar for `gp report`, and a details document. Ports: `model` + `dataset` are the
 * canonical contract of the registry; `baselines` is an optional `many` Bundle port carrying other
 * systems' predictions for the same units.
 */

export const EVALUATE_IMPL = "ts:evaluate.intrinsic@1.0.0";

interface WeightParam {
  feature?: string;
  log1p_scale?: number;
}

interface Params {
  seed: number;
  split?: SplitParam;
  resamples?: number;
  cluster_by?: "group_key" | "group_id";
  stratified?: boolean;
  aggregation?: "micro" | "macro_page";
  threshold?: number | "accept";
  runtime?: Runtime;
  positive_label?: string;
  label_sources?: string[];
  weight?: "none" | WeightParam;
  baselines?: string[];
  gates?: GateParam[];
  pr_points?: number;
}

const PARAMS_SCHEMA = {
  type: "object",
  required: ["seed"],
  additionalProperties: false,
  properties: {
    split: { enum: ["train", "val", "test", "all"], description: "Split to score (default test)." },
    seed: { type: "integer", minimum: 0, description: "Bootstrap seed." },
    resamples: { type: "integer", minimum: 100, description: "Bootstrap resamples (default 1000)." },
    cluster_by: { enum: ["group_key", "group_id"], description: "Resampling unit: group_key (domain, default) or group_id (page)." },
    stratified: { type: "boolean", description: "Redraw clusters within each stratum (default true)." },
    aggregation: { enum: ["micro", "macro_page"], description: "Statistic of comparison[] and of gates (default macro_page)." },
    threshold: { anyOf: [{ type: "number", minimum: 0, maximum: 1 }, { enum: ["accept"] }], description: 'Operating threshold: a number, or "accept" = the package threshold (default).' },
    runtime: { enum: ["ts", "wasm"], description: "Runtime that scores (default ts); both are verified by the package checks." },
    positive_label: { type: "string", description: 'Positive class (default "keep").' },
    label_sources: { type: "array", items: { type: "string" }, description: "Keep only rows of these label sources (e.g. [human])." },
    weight: {
      anyOf: [
        { enum: ["none"] },
        { type: "object", additionalProperties: false, properties: { feature: { type: "string" }, log1p_scale: { type: "number", exclusiveMinimum: 0 } } },
      ],
      description: 'Unit weight: "none" (1 per element) or the feature that holds log1p(chars)/log1p(scale). Default log_own_len with scale 5000, falling back to 1.',
    },
    baselines: { type: "array", items: { type: "string" }, description: "Ids (and order) of the supplied baseline systems to use; default all." },
    gates: { type: "array", items: GATE_PARAM_SCHEMA, description: "Gates evaluated into gates[]; thresholds come from here, never from code." },
    pr_points: { type: "integer", minimum: 2, maximum: 501, description: "Thresholds of the PR curve in the extras (default 51)." },
  },
} as const;

const DEFAULT_WEIGHT = { feature: "log_own_len", log1p_scale: 5000 } as const;
const ZERO_SHA: Sha256 = `sha256:${"0".repeat(64)}`;

interface WeightPlan {
  /** Feature index, or -1 for weight 1. */
  index: number;
  scale: number;
  note: string;
}

/** Character weight of a row = chars of own text, recovered from the static `log1p` transform of a feature. */
export function planWeight(param: Params["weight"], names: readonly string[]): WeightPlan {
  if (param === "none") return { index: -1, scale: 0, note: "Unit weight: 1 per element (params.weight = none): counts are ELEMENTS, not characters." };
  const explicit = param !== undefined;
  const feature = param?.feature ?? DEFAULT_WEIGHT.feature;
  const scale = param?.log1p_scale ?? DEFAULT_WEIGHT.log1p_scale;
  const index = names.indexOf(feature);
  if (index < 0) {
    if (explicit) throw new Error(`params.weight.feature "${feature}" is not a feature of the model (${names.join(", ")})`);
    return {
      index: -1,
      scale: 0,
      note: `Unit weight: 1 per element. The model has no feature "${feature}" to recover the characters of own text from, so counts are ELEMENTS, not characters (the experiment protocol weights by characters). Proposed contract change: an optional integer \`w\` (own text characters) in dataset-row.`,
    };
  }
  return {
    index,
    scale,
    note: `Unit weight: characters of own text, recovered as round(expm1(${feature} * log1p(${scale}))) from the dataset feature. The extractor clips at its scale, so one element weighs at most ${scale} characters. Proposed contract change: an optional integer \`w\` in dataset-row would make this exact.`,
  };
}

export function weightOf(plan: WeightPlan, x: readonly number[]): number {
  if (plan.index < 0) return 1;
  const v = Math.min(1, Math.max(0, x[plan.index] as number));
  return Math.max(0, Math.round(Math.expm1(v * Math.log1p(plan.scale))));
}

const single = (ctx: StageContext, port: string): ArtifactHandle => {
  const h = ctx.inputs[port];
  if (h === undefined || Array.isArray(h)) throw new Error(`input "${port}" is missing`);
  return h;
};

function selectBaselines(ctx: StageContext, wanted: readonly string[] | undefined) {
  const supplied = ctx.inputs["baselines"];
  const handles = supplied === undefined ? [] : Array.isArray(supplied) ? supplied : [supplied];
  const all = handles.map((h, i) => ({ h, sys: readBaseline(h, i) }));
  const ids = all.map((a) => a.sys.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) throw new Error(`two baseline artifacts claim the id "${dup}"`);
  if (wanted === undefined) return all.map((a) => a.sys);
  return wanted.map((id) => {
    const found = all.find((a) => a.sys.id === id);
    if (!found) throw new Error(`params.baselines lists "${id}", but the supplied baseline systems are: ${ids.join(", ") || "none"}`);
    return found.sys;
  });
}

function provenance(ctx: StageContext): EvalReport["provenance"] {
  const inputIds = Object.fromEntries(
    Object.entries(ctx.inputs).map(([port, h]) => [port, Array.isArray(h) ? h.map((x) => x.id) : h.id]),
  ) as Record<string, Sha256 | Sha256[]>;
  const flat = Object.entries(inputIds).flatMap(([port, v]) => (Array.isArray(v) ? v.map((id) => ({ port, artifact_id: id })) : [{ port, artifact_id: v }]));
  const wasm = wasmSha256();
  // Deterministic on purpose: the embedded provenance must not depend on the run (so artifact ids are stable
  // across runs and --force). The runner's receipts and the artifact's meta.json hold the real run provenance.
  return {
    produced_by: {
      run_id: "deterministic",
      stage_id: ctx.stageId,
      kind: ctx.kind,
      impl: ctx.impl,
      params_sha256: artifactId(ctx.params),
      cache_key: stageCacheKey({ impl: ctx.impl, kind: ctx.kind, params: ctx.params, inputIds, wasmSha: wasm }),
    },
    inputs: flat,
    pipeline_spec_id: ZERO_SHA,
    tool_versions: { gp_cli: GP_VERSION, node: process.version, wasm_sha256: wasm },
    created_at: "1970-01-01T00:00:00Z",
    duration_ms: 0,
  };
}

export const evaluateIntrinsic = defineStage(
  {
    kind: "evaluate",
    impl: EVALUATE_IMPL,
    inputs: [
      { name: "model", type: "ModelPackage" },
      { name: "dataset", type: "Dataset" },
      { name: "baselines", type: "Bundle", many: true, optional: true },
    ],
    outputs: [
      { name: "report", type: "EvalReport" },
      { name: "extras", type: "Bundle" },
      { name: "details", type: "Bundle" },
    ],
    params_schema: PARAMS_SCHEMA,
    runtime: "node+wasm",
    determinism: "seeded",
    gates: [{ id: "params_gates", description: "Every entry of params.gates (metric, comparator, threshold, strata, baseline, CI bound) becomes a gates[] entry of the report." }],
  },
  (ctx) => {
    const p = ctx.params as unknown as Params;
    const split: SplitParam = p.split ?? "test";
    const { manifest, rows: raw } = readDataset(single(ctx, "dataset"), split);
    const positiveLabel = p.positive_label ?? "keep";
    if (manifest.label_space.classes[1] !== positiveLabel) {
      throw new Error(`the dataset's positive class is "${manifest.label_space.classes[1]}", params.positive_label is "${positiveLabel}"`);
    }
    const handle = readModel(single(ctx, "model"), p.runtime ?? "ts", positiveLabel);
    try {
      const model = handle.model;
      if (model.inputDim !== manifest.dim) throw new Error(`the model takes ${model.inputDim} features, the dataset has ${manifest.dim}`);
      if (model.manifest.feature_spec.schema_id !== manifest.feature_schema_id) {
        throw new Error(`the model was trained on feature schema ${model.manifest.feature_spec.schema_id}, the dataset uses ${manifest.feature_schema_id}`);
      }
      const rows: DataRow[] = p.label_sources ? raw.filter((r) => (p.label_sources as string[]).includes(r.s)) : raw;
      const info = new Map<string, number>();
      const groups: GroupInfo[] = [];
      for (const g of manifest.groups) {
        info.set(g.group_id, groups.length);
        groups.push({ id: g.group_id, key: g.group_key, stratum: g.stratum });
      }
      const plan = planWeight(p.weight, model.manifest.feature_spec.names);
      const scores = scoreRows(handle, rows);
      const scored: ScoredRow[] = rows.map((r, i) => {
        const g = info.get(r.g);
        if (g === undefined) throw new Error(`row of group "${r.g}" is not in the dataset manifest`);
        return { g, u: r.u, y: r.y as 0 | 1, s: r.s, w: weightOf(plan, r.x), score: scores[i] as number };
      });
      const threshold = p.threshold === undefined || p.threshold === "accept" ? model.thresholds.accept : p.threshold;
      const baselines: BaselineInput[] = selectBaselines(ctx, p.baselines).map((b) => ({ id: b.id, keep: b.keep }));

      const core: CoreOptions = {
        threshold,
        seed: p.seed,
        resamples: p.resamples ?? 1000,
        clusterBy: p.cluster_by ?? "group_key",
        stratified: p.stratified ?? true,
        aggregation: p.aggregation ?? "macro_page",
        gates: p.gates ?? [],
        prGrid: p.pr_points ?? 51,
        notes: [
          { kind: "note", text: plan.note },
          {
            kind: "note",
            text: `Operating threshold ${threshold}${p.threshold === undefined || p.threshold === "accept" ? " (the package's thresholds.accept)" : " (params.threshold)"}; predicted keep = score >= threshold. Positive class = "${positiveLabel}". ${rows.length} rows of split "${split}"${p.label_sources ? `, label sources ${p.label_sources.join("+")}` : ""}.`,
          },
        ],
      };
      const res = evaluateCore({ groups, rows: scored, baselines }, core);
      ctx.log(`${rows.length} rows, ${res.intrinsic.overall.n} weight units, F1 ${res.intrinsic.overall.f1.toFixed(4)} at threshold ${threshold}`);

      const body = {
        format: "gran-prix.eval-report" as const,
        format_version: "1.0.0" as const,
        mode: "intrinsic" as const,
        model_id: model.modelId,
        dataset_id: manifest.dataset_id,
        split,
        threshold,
        intrinsic: res.intrinsic,
        ...(res.gates.length > 0 ? { gates: res.gates } : {}),
        provenance: provenance(ctx),
      };
      const reportId = contractId("eval-report", body as unknown as Record<string, unknown>);
      const report = assertValid("eval-report", { ...body, report_id: reportId });
      const extras: ReportExtras = { names: { model: model.manifest.name }, ...res.extras };
      return {
        report: { json: report },
        extras: { json: extras },
        details: { json: { ...res.details, split, model_id: model.modelId, dataset_id: manifest.dataset_id, weighting: plan.note } },
      };
    } finally {
      handle.model.dispose();
    }
  },
);

export const EVALUATE_STAGES = [evaluateIntrinsic] as const;
