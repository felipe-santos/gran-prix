// ts:train.cv end to end with the real gp-train binary on a small synthetic Dataset (a pipeline test, not a quality claim).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertValid, type PipelineSpec, type Sha256 } from "@gran-prix/contracts";
import { loadModelPackage } from "@gran-prix/model";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore, StageRegistry, checkPipeline, dataPaths, runPipeline, type StagePlugin } from "../src/index.js";
import { ALL_STAGES } from "../src/stages/index.js";
import { packageStage } from "../src/stages/package.js";
import { JOBS_ENV, TRAIN_CV_IMPL, createTrainCvStage } from "../src/stages/train-cv/stage.js";
import { macroPageF1, tauStar, weightedRecall } from "../src/stages/train-cv/tau.js";
import { buildDataset, defaultWeight } from "./evaluate-fixtures.js";
import { cleanupTmp, tmpDir } from "./helpers.js";
import { CV_GROUPS, CV_ROWS, datasetFiles, gpTrainCopy } from "./train-cv-fixtures.js";

afterAll(cleanupTmp);

const SMALL = {
  configs: [
    { name: "small", hidden: [8], lr: 0.02, pos_weight: null },
    { name: "wide", hidden: [16, 8], lr: 0.02, pos_weight: 2 },
  ],
  folds: 3,
  inner_folds: 2,
  epochs: 6,
  seed: 3,
} as const;

let binary = "";
beforeAll(() => {
  binary = gpTrainCopy();
}, 600_000);

const plugins = (): StagePlugin[] => [createTrainCvStage({ binary: () => binary }), packageStage, ...ALL_STAGES.filter((p) => p.spec.impl !== TRAIN_CV_IMPL && p.spec.impl !== packageStage.spec.impl)];

/** The Dataset has a CORRUPTED test.jsonl by default: train.cv must not read it (the manifest still pins the real hash). */
function world(corruptTest = true): { dataDir: string; dataset: Sha256 } {
  const dataDir = tmpDir();
  const store = new ArtifactStore(dataPaths(dataDir).artifacts);
  return { dataDir, dataset: store.putFiles("Dataset", datasetFiles(corruptTest)) };
}

const spec = (dataset: Sha256, params: Record<string, unknown> = SMALL): PipelineSpec => ({
  format: "gran-prix.pipeline-spec",
  format_version: "1.0.0",
  name: "train-cv-mini",
  externals: { dataset: { type: "Dataset", id: dataset } },
  stages: [
    { id: "cv", kind: "train", impl: TRAIN_CV_IMPL, params, inputs: { dataset: { external: "dataset" } } },
    { id: "package", kind: "package", impl: "ts:package.bundle@1.0.0", params: {}, inputs: { model: { stage: "cv", output: "model" } } },
  ],
});

const text = (dataDir: string, id: string, file: string): string => readFileSync(join(new ArtifactStore(dataPaths(dataDir).artifacts).dirOf(id as Sha256), "files", file), "utf8");
const json = <T>(dataDir: string, id: string): T => JSON.parse(readFileSync(join(new ArtifactStore(dataPaths(dataDir).artifacts).dirOf(id as Sha256), "content.json"), "utf8")) as T;

describe("ts:train.cv", () => {
  it("is registered with the ports of the decision chain and validates in a pipeline", () => {
    const reg = new StageRegistry(ALL_STAGES);
    expect(reg.get(TRAIN_CV_IMPL)?.spec).toMatchObject({ kind: "train", runtime: "rust", determinism: "seeded" });
    expect(reg.get(TRAIN_CV_IMPL)?.spec.outputs.map((o) => `${o.name}:${o.type}`)).toEqual(["model:ModelPackage", "oof:Bundle", "config:TrainConfig", "report:Bundle"]);
    const w = world();
    expect(checkPipeline(spec(w.dataset), reg).ok).toBe(true);
    // more than 12 configurations is refused by the schema (protocol 7), and a seed is required
    const many = Array.from({ length: 13 }, (_, i) => ({ name: `c${i}`, hidden: [4], lr: 0.01, pos_weight: null }));
    expect(checkPipeline(spec(w.dataset, { ...SMALL, configs: many }), reg).ok).toBe(false);
    expect(checkPipeline(spec(w.dataset, { configs: SMALL.configs }), reg).ok).toBe(false);
  });

  it("writes the OOF bundle, tau*, the chosen config and a final model whose accept is tau*, never reading test.jsonl", async () => {
    const w = world(true);
    const run = await runPipeline(spec(w.dataset), { dataDir: w.dataDir, plugins: plugins() });
    expect(run.stages.map((s) => `${s.stageId}:${s.status}${s.error ? ` (${s.error})` : ""}`)).toEqual(["cv:ran", "package:ran"]);
    const out = run.stages[0]?.outputs as Record<string, Sha256>;

    // the OOF bundle: one prediction per dev row, in the GBDT's format, with system.json = {id, threshold}
    const preds = text(w.dataDir, out["oof"] as string, "predictions.jsonl").trim().split("\n").map((l) => JSON.parse(l) as { g: string; u: number; p: number });
    const devRows = CV_ROWS.filter((r) => CV_GROUPS.find((g) => g.id === r.g)?.split !== "test");
    expect(preds).toHaveLength(devRows.length);
    expect(new Set(preds.map((r) => `${r.g}/${r.u}`))).toEqual(new Set(devRows.map((r) => `${r.g}/${r.u}`)));
    expect(preds.every((r) => r.p >= 0 && r.p <= 1)).toBe(true);
    expect(preds.some((r) => r.g.startsWith("t"))).toBe(false);
    const system = JSON.parse(text(w.dataDir, out["oof"] as string, "system.json")) as { id: string; threshold: number };
    expect(system.id).toBe("mlp-s3");

    // tau* is the pure function applied to those predictions, with the dataset's character weights
    const y = devRows.map((r) => r.y);
    const wt = devRows.map((r) => defaultWeight(r));
    const byKey = new Map(preds.map((r) => [`${r.g}/${r.u}`, r.p]));
    const p = devRows.map((r) => byKey.get(`${r.g}/${r.u}`) as number);
    expect(system.threshold).toBe(tauStar(p, y, wt));
    expect(weightedRecall(p, y, wt, system.threshold)).toBeGreaterThanOrEqual(0.95);

    // the chosen config: a valid TrainConfig whose fixed threshold is tau*
    const config = json<{ threshold: { strategy: string; value: number }; seed: number }>(w.dataDir, out["config"] as string);
    assertValid("train-config", config);
    expect(config).toMatchObject({ seed: 3, threshold: { strategy: "fixed", value: system.threshold } });

    // the report names everything a reader needs, and says that the test split was not read
    const report = json<Record<string, any>>(w.dataDir, out["report"] as string);
    expect(report).toMatchObject({
      impl: TRAIN_CV_IMPL,
      test_split_read: false,
      split_read: ["train", "val"],
      folds: { outer: 3, inner: 2 },
      grid: { name: "params.configs", size: 2, budget: 12 },
      tau_star: system.threshold,
      dev: { rows: devRows.length, pages: 14, domains: 14 },
    });
    expect(report.configs).toHaveLength(2);
    expect(report.outer_fold_selection).toHaveLength(3);
    expect(report.dev_oof_macro_page_f1_at_tau).toBeCloseTo(macroPageF1(p, y, wt, devRows.map((r) => r.g), system.threshold), 5);
    expect(report.fits).toEqual({ cv: 2 * 3 + 3 * (2 * 2 + 1), final: 1 });

    // the final model: a verified ModelPackage (nine checks, both runtimes), accept = tau*, then a deployable bundle
    const dir = join(new ArtifactStore(dataPaths(w.dataDir).artifacts).dirOf(out["model"] as Sha256), "files");
    for (const runtime of ["ts", "wasm"] as const) {
      const m = loadModelPackage(dir, { runtime });
      expect(m.thresholds.accept).toBeCloseTo(system.threshold, 6);
      expect(m.manifest.feature_spec.dim).toBe(4);
      m.dispose();
    }
    const pk = run.stages[1]?.outputs as Record<string, Sha256>;
    expect(JSON.parse(text(w.dataDir, pk["bundle"] as string, "bundle.json"))).toMatchObject({ self_test: expect.anything() });
  }, 300_000);

  it('fits with sample_weight "row" when the dataset has row weights (same weight as the GBDT), and not otherwise', async () => {
    const w = world();
    const run = await runPipeline(spec(w.dataset), { dataDir: w.dataDir, plugins: plugins() });
    const out = run.stages[0]?.outputs as Record<string, Sha256>;
    const config = json<{ format_version: string; sample_weight?: string }>(w.dataDir, out["config"] as string);
    assertValid("train-config", config);
    expect(config).toMatchObject({ format_version: "1.1.0", sample_weight: "row" });
    const report = json<Record<string, any>>(w.dataDir, out["report"] as string);
    expect(report["fixed"].sample_weight).toBe("row");
    // the trainer really got the weights: the final model's own training report says so
    const trained = JSON.parse(text(w.dataDir, out["model"] as string, "train_report.json")) as { sample_weight?: string };
    expect(trained.sample_weight).toBe("row");

    // the same rows without `w` / row_weight: unweighted, as before (a 1.0.0 config), and a different model
    const dataDir = tmpDir();
    const store = new ArtifactStore(dataPaths(dataDir).artifacts);
    const unweighted = store.putFiles("Dataset", buildDataset(CV_GROUPS, CV_ROWS, {}));
    const plainRun = await runPipeline(spec(unweighted), { dataDir, plugins: plugins() });
    expect(plainRun.ok).toBe(true);
    const plainOut = plainRun.stages[0]?.outputs as Record<string, Sha256>;
    const plainConfig = json<{ format_version: string; sample_weight?: string }>(dataDir, plainOut["config"] as string);
    expect(plainConfig).toMatchObject({ format_version: "1.0.0" });
    expect(plainConfig.sample_weight).toBeUndefined();
    expect(JSON.parse(text(dataDir, plainOut["model"] as string, "train_report.json"))).not.toHaveProperty("sample_weight");
    expect(json<Record<string, any>>(dataDir, plainOut["report"] as string)["fixed"].sample_weight).toBe("none");
    expect(plainOut["model"]).not.toBe(out["model"]);
  }, 300_000);

  it("is reproducible: a fresh data dir gives the same artifact ids, whatever GP_CV_JOBS is", async () => {
    const a = world();
    const b = world();
    const saved = process.env[JOBS_ENV];
    try {
      process.env[JOBS_ENV] = "1";
      const first = await runPipeline(spec(a.dataset), { dataDir: a.dataDir, plugins: plugins() });
      process.env[JOBS_ENV] = "5";
      const second = await runPipeline(spec(b.dataset), { dataDir: b.dataDir, plugins: plugins() });
      expect(first.ok && second.ok).toBe(true);
      // fits run one at a time or five at a time: the same OOF, the same final model, the same report
      expect(second.stages.map((s) => s.outputs)).toEqual(first.stages.map((s) => s.outputs));
      expect(second.stages.map((s) => s.cacheKey)).toEqual(first.stages.map((s) => s.cacheKey));
    } finally {
      if (saved === undefined) delete process.env[JOBS_ENV];
      else process.env[JOBS_ENV] = saved;
    }
  }, 300_000);

  it("is a 100% cache hit the second time, and a changed grid or seed is a new run", async () => {
    const w = world();
    const first = await runPipeline(spec(w.dataset), { dataDir: w.dataDir, plugins: plugins() });
    const again = await runPipeline(spec(w.dataset), { dataDir: w.dataDir, plugins: plugins() });
    expect(again.counts).toMatchObject({ ran: 0, cached: 2 });
    expect(again.stages[0]?.outputs).toEqual(first.stages[0]?.outputs);
    const other = await runPipeline(spec(w.dataset, { ...SMALL, seed: 4 }), { dataDir: w.dataDir, plugins: plugins() });
    expect(other.counts.ran).toBe(2);
    const report = (r: typeof first) => json<{ system_id: string }>(w.dataDir, (r.stages[0]?.outputs as Record<string, string>)["report"] as string);
    expect(report(other).system_id).toBe("mlp-s4");
    expect(report(first).system_id).toBe("mlp-s3");
  }, 300_000);

  it("fails loudly: fewer domains than folds, an unknown grid, a missing binary", async () => {
    const w = world();
    const tooMany = await runPipeline(spec(w.dataset, { ...SMALL, folds: 20 }), { dataDir: w.dataDir, plugins: plugins() });
    expect(tooMany.ok).toBe(false);
    expect(tooMany.stages[0]?.error).toMatch(/cannot fill 20 folds/);
    await expect(runPipeline(spec(w.dataset, { seed: 1, grid_name: "nope" }), { dataDir: w.dataDir, plugins: plugins() })).rejects.toThrow(/grid_name/);
    const gone = createTrainCvStage({ binary: () => join(tmpDir(), "no-such-binary") });
    expect(() => gone.toolDigests?.()).toThrow(/gp-train binary not found/);
  }, 300_000);
});
