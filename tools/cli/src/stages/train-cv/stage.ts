import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { LABEL_SOURCES, canonicalJson, sha256Of, type LabelSource, type Sha256, type TrainConfig } from "@gran-prix/contracts";
import { defineStage, type StageContext, type StageOutputs, type StagePlugin } from "../../stage.js";
import type { ArtifactHandle } from "../../store.js";
import { defaultGpTrainPath } from "../train.js";
import { runCv, type CvResult } from "./cv.js";
import { readDev, type DevData } from "./data.js";
import { fitAndPredict, requireBinary, type FitProvenance } from "./fit.js";
import { FIXED, GRIDS, assertBudget, trainConfigOf, type DataPolicy, type GridPoint } from "./grid.js";
import { RECALL_TARGET, macroPageF1, weightedRecall } from "./tau.js";

/**
 * `ts:train.cv@1.0.0`: the MLP's out-of-fold predictions on dev, the chosen configuration and the final model
 * (protocol 3, 6.3, 7). It orchestrates `gp-train` (one process per fit, run in parallel) and scores the fits with the
 * TS runtime of `@gran-prix/model`; the stage is TS because everything it adds (folds, nesting, tau*, bundles) is
 * orchestration, and the numerics stay in the Rust trainer. The test split is NEVER read: dev = train + val.
 *
 *  - `dataset` -> `oof` (Bundle: `predictions.jsonl` + `system.json {id, threshold = tau*}`, the format of
 *    `gbdt.py`'s `bundle-dev-oof/`, so `evaluate` scores MLP and GBDT the same way), `config` (TrainConfig: the chosen
 *    configuration, with `threshold.fixed = tau*`), `model` (ModelPackage: that configuration refit on ALL of dev,
 *    `thresholds.accept = tau*`; `package` turns it into a Bundle) and `report` (the grid's scores, picks, tau*).
 *  - Selection criterion and tau* are those of the GBDT (`tau.ts`), tuning is nested (`cv.ts`), the grid is fixed in
 *    code (`grid.ts`, <= 12 configurations). Weight: selection and tau* use the dataset's character weights `w`, and
 *    (since TrainConfig 1.1.0) every fit trains with `sample_weight: "row"` on the same `w`, as the GBDT does; a
 *    dataset without `row_weight` is 1 per row for the selection and unweighted for the fits. One instance = one seed; the protocol's 5 seeds are 5 instances.
 *  - Reproducible: no clock and no machine fact enters an output; `toolDigests` pins gp-train and the grid.
 */

export const TRAIN_CV_IMPL = "ts:train.cv@1.0.0";

export interface TrainCvOptions {
  binary?: () => string;
}

interface Params {
  seed: number;
  folds?: number;
  inner_folds?: number;
  grid_name?: string;
  configs?: GridPoint[];
  epochs?: number;
  system_id?: string;
  data_policy?: { min_confidence?: number; allowed_sources?: LabelSource[] };
  name?: string;
  task_name?: string;
  created_at?: string;
}

/** Environment override of the number of fits running at once. Not a param: it never changes a result, so it must not change the cache key. */
export const JOBS_ENV = "GP_CV_JOBS";

function jobsFromEnv(): number {
  const raw = process.env[JOBS_ENV];
  if (raw === undefined || raw === "") return Math.max(1, Math.min(4, availableParallelism()));
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${JOBS_ENV} must be an integer >= 1 (got "${raw}")`);
  return n;
}

const DEFAULT_CREATED_AT = "1970-01-01T00:00:00Z";
const DEFAULT_FOLDS = 5;
const DEFAULT_INNER_FOLDS = 3;

const PARAMS_SCHEMA = {
  type: "object",
  required: ["seed"],
  additionalProperties: false,
  properties: {
    seed: { type: "integer", minimum: 0, maximum: 4294967295, description: "Seed of every fit (init and shuffling). The protocol's seeds are 1-5: one instance each." },
    folds: { type: "integer", minimum: 2, description: "Outer folds (default: the manifest's split.kfold.k, else 5)." },
    inner_folds: { type: "integer", minimum: 2, description: `Folds of the inner tuning inside every outer fold (default ${DEFAULT_INNER_FOLDS}, like the GBDT).` },
    grid_name: { type: "string", enum: Object.keys(GRIDS), description: "A named, versioned grid defined in code (default dom-v0-mlp-v1: 12 configurations)." },
    configs: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        required: ["name", "hidden", "lr", "pos_weight"],
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1 },
          hidden: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1 },
          lr: { type: "number", exclusiveMinimum: 0 },
          pos_weight: { anyOf: [{ type: "number", exclusiveMinimum: 0 }, { type: "null" }] },
        },
      },
      description: "Explicit grid (at most 12 configurations), instead of grid_name. For tests and declared variants; the experiment uses grid_name.",
    },
    epochs: { type: "integer", minimum: 1, description: `Epochs of every fit (default ${FIXED.epochs}).` },
    system_id: { type: "string", minLength: 1, description: "id of the OOF Bundle's system (default mlp-s<seed>)." },
    data_policy: {
      type: "object",
      additionalProperties: false,
      properties: {
        min_confidence: { type: "number", minimum: 0, maximum: 1 },
        allowed_sources: { type: "array", items: { enum: [...LABEL_SOURCES] }, minItems: 1, uniqueItems: true },
      },
      description: "Rows the trainer may fit on. Default: exactly what the dataset manifest admitted (filters).",
    },
    name: { type: "string", minLength: 1 },
    task_name: { type: "string", minLength: 1 },
    created_at: { type: "string", description: "RFC 3339 UTC written to model.json (default: the epoch, to keep the package reproducible)." },
  },
} as const;

/** Digest of everything in code that decides what a fit is: the grids and the fixed hyperparameters. */
export function gridDigest(): Sha256 {
  return sha256Of(canonicalJson({ impl: TRAIN_CV_IMPL, fixed: FIXED, recall_target: RECALL_TARGET, sample_weight: "row when the dataset declares row_weight", grids: GRIDS }));
}

const single = (ctx: StageContext, port: string): ArtifactHandle => {
  const h = ctx.inputs[port];
  if (h === undefined || Array.isArray(h)) throw new Error(`input "${port}" is missing`);
  return h;
};

function policyOf(dev: DevData, p: Params): DataPolicy {
  const f = dev.manifest.filters;
  return {
    min_confidence: p.data_policy?.min_confidence ?? f.min_confidence,
    allowed_sources: p.data_policy?.allowed_sources ?? [...f.allowed_sources],
  };
}

function gridOf(p: Params): { name: string; points: readonly GridPoint[] } {
  if (p.configs !== undefined && p.grid_name !== undefined) throw new Error("params.configs and params.grid_name are exclusive");
  const points = p.configs ?? GRIDS[p.grid_name ?? "dom-v0-mlp-v1"];
  if (points === undefined) throw new Error(`unknown grid "${String(p.grid_name)}" (known: ${Object.keys(GRIDS).join(", ")})`);
  assertBudget(points);
  return { name: p.configs !== undefined ? "params.configs" : (p.grid_name ?? "dom-v0-mlp-v1"), points };
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

function oofBundle(dev: DevData, cv: CvResult, systemId: string): Record<string, string> {
  const lines: string[] = [];
  for (let i = 0; i < dev.n; i++) lines.push(JSON.stringify({ g: dev.g[i], u: dev.u[i], p: cv.oof[i] }));
  return { "predictions.jsonl": `${lines.join("\n")}\n`, "system.json": `${JSON.stringify({ id: systemId, threshold: cv.tau })}\n` };
}

function byStratum(dev: DevData, cv: CvResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of [...new Set(dev.stratum)].sort()) {
    const idx = dev.stratum.flatMap((x, i) => (x === s ? [i] : []));
    out[s] = round6(macroPageF1(idx.map((i) => cv.oof[i] as number), idx.map((i) => dev.y[i] as number), idx.map((i) => dev.w[i] as number), idx.map((i) => dev.g[i] as string), cv.tau));
  }
  return out;
}

async function run(binary: string, ctx: StageContext): Promise<StageOutputs> {
  const p = ctx.params as unknown as Params;
  const dev = readDev(single(ctx, "dataset"));
  const { name: gridName, points } = gridOf(p);
  const epochs = p.epochs ?? FIXED.epochs;
  const policy = policyOf(dev, p);
  const folds = p.folds ?? dev.manifest.split.kfold?.k ?? DEFAULT_FOLDS;
  const innerFolds = p.inner_folds ?? DEFAULT_INNER_FOLDS;
  const jobs = jobsFromEnv();
  const systemId = p.system_id ?? `mlp-s${p.seed}`;
  const hex = ctx.cacheKey.slice("sha256:".length);
  const provenance: FitProvenance = {
    // The package must be a pure function of (params, inputs, binary): the real run id lives in the receipt.
    runId: `cache-${hex.slice(0, 16)}`,
    stageId: ctx.stageId,
    cacheKey: ctx.cacheKey,
    pipelineSpecId: ctx.pipelineSpecId,
    createdAt: p.created_at ?? DEFAULT_CREATED_AT,
    ...(p.name !== undefined ? { name: p.name } : {}),
    ...(p.task_name !== undefined ? { taskName: p.task_name } : {}),
  };
  const pages = new Set(dev.g).size;
  const domains = new Set(dev.key).size;
  ctx.log(`dev: ${dev.n} rows, ${pages} pages, ${domains} domains; ${points.length} configurations (${gridName}), ${folds} outer x ${innerFolds} inner folds, seed ${p.seed}, ${jobs} jobs`);

  let done = 0;
  const cv = await runCv(
    dev,
    points,
    async (point, fit, predict) => {
      const r = await fitAndPredict({ binary, dev, config: trainConfigOf(point, p.seed, policy, 0.5, epochs, dev.weighted), seed: p.seed, fit, predict, provenance });
      if (++done % 50 === 0) ctx.log(`${done} fits done`);
      return r.p;
    },
    { folds, innerFolds, jobs },
  );
  ctx.log(`selected ${(points[cv.selected] as GridPoint).name}; tau* ${cv.tau}; dev OOF macro-page F1 ${cv.macroPageF1.toFixed(4)}; ${cv.fits} fits`);

  // The frozen model: the selected configuration refit on ALL of dev, accept = tau* from the nested OOF.
  const chosen = points[cv.selected] as GridPoint;
  const finalConfig: TrainConfig = trainConfigOf(chosen, p.seed, policy, cv.tau, epochs, dev.weighted);
  const all = Array.from({ length: dev.n }, (_, i) => i);
  const final = await fitAndPredict({ binary, dev, config: finalConfig, seed: p.seed, fit: all, predict: all, keepPackage: true, provenance });
  const files = final.files as Record<string, Uint8Array>;
  const accept = readAccept(files);
  if (Math.abs(accept - cv.tau) > 1e-6) throw new Error(`the final model's thresholds.accept (${accept}) is not tau* (${cv.tau})`);
  const recallInSample = weightedRecall(final.p, dev.y, dev.w, accept);

  const report = {
    format: "gran-prix.train-cv-report",
    format_version: "1.0.0",
    impl: TRAIN_CV_IMPL,
    system_id: systemId,
    seed: p.seed,
    dataset_id: dev.manifest.dataset_id,
    split_read: ["train", "val"],
    test_split_read: false,
    folds: { outer: folds, inner: innerFolds, by: "group_key (registrable domain), deterministic greedy balance, no randomness" },
    dev: { rows: dev.n, pages, domains, weighting: dev.weighted ? "dataset-row.w (own-text characters)" : "1 per row" },
    data_policy: policy,
    fixed: { epochs, batch_size: FIXED.batch_size, sample_weight: dev.weighted ? "row" : "none", early_stopping: false, validation_split: false, optimizer: "adam", lr_schedule: "cosine", normalization: "zscore fitted on the fitting rows" },
    grid: { name: gridName, size: points.length, budget: 12 },
    configs: points.map((pt, i) => ({ index: i, ...pt, dev_cv_macro_page_f1_at_tau: round6(cv.scores[i] as number), tau_star: cv.taus[i] })),
    selected: { index: cv.selected, config: chosen, train_config_id: finalConfig.train_config_id },
    selection_rule: "highest macro-page F1 at the configuration's own tau* on the all-dev grouped-CV OOF; ties go to the earlier configuration",
    outer_fold_selection: cv.outerPicks.map((c) => (points[c] as GridPoint).name),
    inner_scores: cv.innerScores.map((row) => row.map(round6)),
    tau_star: cv.tau,
    tau_rule: `largest threshold with character-weighted recall >= ${RECALL_TARGET} on the nested dev OOF`,
    dev_oof_macro_page_f1_at_tau: round6(cv.macroPageF1),
    dev_oof_macro_page_f1_by_stratum: byStratum(dev, cv),
    final_model: { fit_rows: dev.n, thresholds_accept: accept, in_sample_recall_at_accept: round6(recallInSample), note: "in-sample numbers are not evidence; the dev claim is the OOF" },
    fits: { cv: cv.fits, final: 1 },
  };
  return {
    model: { files },
    oof: { files: oofBundle(dev, cv, systemId) },
    config: { json: finalConfig },
    report: { json: report },
  };
}

function readAccept(files: Record<string, Uint8Array>): number {
  const model = JSON.parse(new TextDecoder().decode(files["model.json"])) as { thresholds: { accept: number } };
  return model.thresholds.accept;
}

export function createTrainCvStage(options: TrainCvOptions = {}): StagePlugin {
  const locate = options.binary ?? defaultGpTrainPath;
  const plugin = defineStage(
    {
      kind: "train",
      impl: TRAIN_CV_IMPL,
      inputs: [{ name: "dataset", type: "Dataset" }],
      outputs: [
        { name: "model", type: "ModelPackage" },
        { name: "oof", type: "Bundle" },
        { name: "config", type: "TrainConfig" },
        { name: "report", type: "Bundle" },
      ],
      params_schema: PARAMS_SCHEMA,
      runtime: "rust",
      determinism: "seeded",
    },
    // Nothing leaves the stage unverified: every package, the final one included, is loaded with the nine checks
    // of ADR-003 (`predictRows` in fit.ts) before its scores are used.
    (ctx) => run(requireBinary(locate()), ctx),
  );
  return {
    ...plugin,
    toolDigests: (): Record<string, Sha256> => ({
      "gp-train": sha256Of(new Uint8Array(readFileSync(requireBinary(locate())))),
      "train-cv-grid": gridDigest(),
    }),
  };
}

export const trainCvStage = createTrainCvStage();
export const TRAIN_CV_STAGES: readonly StagePlugin[] = [trainCvStage];
