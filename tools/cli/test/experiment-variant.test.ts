// pipelines/dom-v0-experiment.json: (1) the real spec validates against the real stage registry and is wired as the protocol
// says; (2) a SMALL VARIANT of it (the real stage definitions of one seed branch, over a synthetic Dataset, a tiny grid)
// runs end to end with the real gp-train: train.cv -> package -> evaluate on dev (OOF bundle as a baseline) -> evaluate on
// the test, opened once. It shows the path working; it claims nothing about quality.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalReport, PipelineSpec, Sha256 } from "@gran-prix/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore, StageRegistry, checkPipeline, dataPaths, runPipeline, type StagePlugin } from "../src/index.js";
import { readOpenings } from "../src/stages/evaluate/openings.js";
import { ALL_STAGES } from "../src/stages/index.js";
import { TRAIN_CV_IMPL, createTrainCvStage } from "../src/stages/train-cv/stage.js";
import { cleanupTmp, tmpDir } from "./helpers.js";
import { CV_GROUPS, CV_ROWS, datasetFiles, gpTrainCopy } from "./train-cv-fixtures.js";

afterAll(cleanupTmp);

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const experiment = JSON.parse(readFileSync(join(REPO, "pipelines/dom-v0-experiment.json"), "utf8")) as PipelineSpec;
const registry = new StageRegistry(ALL_STAGES);
type Stage = PipelineSpec["stages"][number];
const stage = (id: string): Stage & { params: Record<string, any>; inputs: Record<string, any> } => experiment.stages.find((s) => s.id === id) as never;
const SEEDS = [1, 2, 3, 4, 5];

describe("pipelines/dom-v0-experiment.json", () => {
  it("passes the same check as `gp validate` against the real stage registry", () => {
    const r = checkPipeline(experiment, registry);
    expect(r.ok ? [] : r.issues).toEqual([]);
  });

  it("is the chain of the protocol: snapshots -> features -> labels -> merge -> dataset -> 5 x (cv -> package) -> dev OOF and test evaluations", () => {
    expect(experiment.stages.filter((s) => s.kind === "train").map((s) => s.id)).toEqual(SEEDS.map((s) => `cv_s${s}`));
    expect(stage("label_merge").inputs["layers"]).toEqual([{ external: "labels_human" }, { external: "labels_llm" }]);
    expect(stage("dataset").inputs["labels"]).toEqual({ stage: "label_merge", output: "labels" });
    // the split of section 3: hash buckets of the domain, 55 / 15 / 30, the pre-registered salt family
    expect(stage("dataset").params["split"]).toMatchObject({ group_by: "group_key", ranges: { train: [0, 55], val: [55, 70], test: [70, 100] } });
    expect(experiment.vars?.["split_salt"]).toMatch(/^gp-dom-v0-s\d+$/);
    for (const s of SEEDS) {
      expect(stage(`cv_s${s}`).params).toMatchObject({ seed: s, grid_name: "dom-v0-mlp-v1" });
      expect(stage(`cv_s${s}`).inputs).toEqual({ dataset: { stage: "dataset", output: "dataset" } });
      expect(stage(`package_s${s}`).inputs["model"]).toEqual({ stage: `cv_s${s}`, output: "model" });
      // one frozen model per seed is scored on the test, and only there
      const t = stage(`eval_test_s${s}`);
      expect(t.params).toMatchObject({ split: "test", threshold: "accept", seed: "${vars.bootstrap_seed}" });
      expect(t.inputs["model"]).toEqual({ stage: `cv_s${s}`, output: "model" });
      expect(t.inputs["baselines"]).toEqual([{ external: "gbdt_test" }]);
    }
    // dev: the five OOF bundles and the GBDT's, scored the same way as the heuristics; the in-sample model is only the required port
    const dev = stage("eval_dev");
    expect(dev.params["split"]).toBe("dev");
    expect(dev.inputs["baselines"]).toEqual([...SEEDS.map((s) => ({ stage: `cv_s${s}`, output: "oof" })), { external: "gbdt_dev_oof" }]);
    expect(dev.inputs["label_baselines"]).toHaveLength(7);
    expect(dev.params["label_baseline"].names).toHaveLength(7);
    expect(new Set(experiment.stages.filter((s) => s.kind === "evaluate").map((s) => JSON.stringify(s.inputs["label_baselines"]))).size).toBe(1);
    // the hard aggregate and the percentile bootstrap by domain of section 6.5; the thresholds live in the decision config, not here
    expect(dev.params["aggregates"]).toEqual([{ name: "hard", strata: ["product", "docs", "forum", "landing", "spa"] }]);
    expect(dev.params).toMatchObject({ cluster_by: "group_key", stratified: true, aggregation: "macro_page", gates: [] });
    expect(experiment.vars).toMatchObject({ bootstrap_seed: 20261125, resamples: 10000 });
    // every baseline of the heuristic family is a stage; all of them keep unusable pages in the comparison (min_coverage 0)
    for (const s of experiment.stages.filter((x) => x.id.startsWith("label_") && x.id !== "label_merge")) expect(s.params["min_coverage"]).toBe(0);
  });

  it("points its externals into data/ (nothing exists yet), and the run fails fast, naming the missing path", async () => {
    for (const e of Object.values(experiment.externals ?? {})) expect(e.path?.startsWith("data/") || e.path?.startsWith("packages/")).toBe(true);
    const dataDir = tmpDir();
    const r = await runPipeline(experiment, { dataDir, root: tmpDir() });
    expect(r.ok).toBe(false);
    expect(r.stages.find((s) => s.status === "failed")?.error).toMatch(/external "snapshots": file .*data\/snapshots does not exist/);
  });
});

// ------------------------------------------------------------------------------------------------ the small variant

let binary = "";
beforeAll(() => {
  binary = gpTrainCopy();
}, 600_000);

const plugins = (): StagePlugin[] => [createTrainCvStage({ binary: () => binary }), ...ALL_STAGES.filter((p) => p.spec.impl !== TRAIN_CV_IMPL)];

/** The real definitions of the seed-1 branch, over a synthetic dataset, a tiny grid and the synthetic strata. */
function variant(dataset: Sha256, heuristic: Sha256): PipelineSpec {
  const tiny = { configs: [{ name: "tiny", hidden: [8], lr: 0.02, pos_weight: null }, { name: "wider", hidden: [16, 8], lr: 0.02, pos_weight: 2 }], folds: 3, inner_folds: 2, epochs: 6 };
  const { grid_name: _g, ...cvParams } = stage("cv_s1").params;
  const evalParams = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...stage(id).params,
    resamples: 200,
    aggregates: [{ name: "hard", strata: id === "eval_dev" ? ["docs", "shop", "forum"] : ["docs", "shop"] }],
    label_baseline: undefined,
    ...over,
  });
  const clean = (p: Record<string, unknown>): Stage["params"] => JSON.parse(JSON.stringify(p)) as Stage["params"];
  return {
    format: "gran-prix.pipeline-spec",
    format_version: "1.0.0",
    name: "dom-v0-experiment-variant",
    vars: experiment.vars as NonNullable<PipelineSpec["vars"]>,
    externals: { dataset: { type: "Dataset", id: dataset }, heuristic: { type: "Bundle", id: heuristic } },
    stages: [
      { ...stage("cv_s1"), params: clean({ ...cvParams, ...tiny }), inputs: { dataset: { external: "dataset" } } },
      { ...stage("package_s1") },
      { ...stage("eval_dev"), params: clean(evalParams("eval_dev")), inputs: { model: { stage: "cv_s1", output: "model" }, dataset: { external: "dataset" }, baselines: [{ stage: "cv_s1", output: "oof" }, { external: "heuristic" }] } },
      { ...stage("eval_test_s1"), params: clean(evalParams("eval_test_s1")), inputs: { model: { stage: "cv_s1", output: "model" }, dataset: { external: "dataset" }, baselines: [{ external: "heuristic" }] } },
    ],
  };
}

describe("a small variant of the experiment, end to end", () => {
  it("trains with grouped nested CV, scores the OOF bundle on dev like any baseline, freezes tau*, and opens the test once", async () => {
    const dataDir = tmpDir();
    const store = new ArtifactStore(dataPaths(dataDir).artifacts);
    const dataset = store.putFiles("Dataset", datasetFiles(false));
    // a "heuristic" baseline bundle covering every page: keep when the first feature (text length) is large
    const heuristic = store.putJson("Bundle", { id: "heur", predictions: CV_ROWS.map((r) => ({ g: r.g, u: r.u, p: (r.x[0] as number) > 0.5 ? 1 : 0 })) });
    const spec = variant(dataset, heuristic);
    const reg = new StageRegistry(plugins());
    expect((checkPipeline(spec, reg) as { ok: boolean; issues?: unknown }).ok, JSON.stringify((checkPipeline(spec, reg) as { issues?: unknown }).issues)).toBe(true);

    const run = await runPipeline(spec, { dataDir, plugins: plugins() });
    expect(run.stages.map((s) => `${s.stageId}:${s.status}${s.error ? ` (${s.error})` : ""}`)).toEqual(["cv_s1:ran", "package_s1:ran", "eval_dev:ran", "eval_test_s1:ran"]);
    const out = (id: string): Record<string, Sha256> => run.stages.find((s) => s.stageId === id)?.outputs as Record<string, Sha256>;
    const json = <T>(id: Sha256, type: string): T => store.handle(id, type as never).json() as T;
    const cv = json<{ tau_star: number; dev_oof_macro_page_f1_at_tau: number; system_id: string }>(out("cv_s1")["report"] as Sha256, "Bundle");
    const dev = json<EvalReport>(out("eval_dev")["report"] as Sha256, "EvalReport");
    const test = json<EvalReport>(out("eval_test_s1")["report"] as Sha256, "EvalReport");

    // dev: only train + val pages, and the OOF bundle enters as a baseline named after its system.json
    const devPages = CV_GROUPS.filter((g) => g.split !== "test").map((g) => g.id).sort();
    expect(dev.intrinsic?.per_group.map((g) => g.group_id).sort()).toEqual(devPages);
    expect(Object.keys(dev.intrinsic?.baselines ?? {}).sort()).toEqual(["heur", "mlp-s1"]);
    expect(dev.intrinsic?.baselines["mlp-s1"]?.coverage).toBe(1);
    expect(dev.notes?.some((n) => /test split was NOT read/.test(n.text))).toBe(true);
    expect(dev.notes?.some((n) => n.kind === "threat" && /in-sample/.test(n.text))).toBe(true);
    // evaluate scores the OOF exactly as train.cv does: macro-page F1 of the OOF at tau* (the report rounds to 6 places)
    const pages = dev.intrinsic?.per_group ?? [];
    const evaluated = pages.reduce((a, g) => a + (g.f1_by_baseline?.["mlp-s1"] as number), 0) / pages.length;
    expect(evaluated).toBeCloseTo(cv.dev_oof_macro_page_f1_at_tau, 5);
    expect(cv.system_id).toBe("mlp-s1");

    // the frozen model carries tau* as its accept threshold, and the test is scored with it
    expect(test.threshold).toBeCloseTo(cv.tau_star, 6);
    expect(test.split).toBe("test");
    expect(test.intrinsic?.per_group.map((g) => g.group_id).sort()).toEqual(CV_GROUPS.filter((g) => g.split === "test").map((g) => g.id).sort());
    expect(Object.keys(test.intrinsic?.baselines ?? {})).toEqual(["heur"]);
    expect(test.intrinsic?.aggregates?.[0]?.name).toBe("hard");

    // blindness: ONE opening registered (dev never registers); a second look at the same (model, dataset) is refused
    expect(readOpenings(dataDir).map((o) => `${o.stage_id}:${o.split}`)).toEqual(["eval_test_s1:test"]);
    const again = await runPipeline(
      { ...spec, stages: spec.stages.map((s) => (s.id === "eval_test_s1" ? { ...s, params: { ...s.params, resamples: 300 } } : s)) },
      { dataDir, plugins: plugins() },
    );
    expect(again.stages.find((s) => s.stageId === "eval_test_s1")?.error).toMatch(/already opened/);
    expect(readOpenings(dataDir)).toHaveLength(1);

    // the deployable bundle is there too (package: nine checks and the generated module's self-test)
    expect(JSON.parse(new TextDecoder().decode(store.handle(out("package_s1")["bundle"] as Sha256, "Bundle").file("bundle.json")))).toMatchObject({ self_test: expect.anything() });
  }, 600_000);
});

// ------------------------------------------------------------------------------ the GBDT beside the MLP, when Python is set up

const BASELINES = fileURLToPath(new URL("../../baselines/", import.meta.url));
const PYLIBS = join(BASELINES, ".pylibs");
const hasGbdt = existsSync(join(PYLIBS, "sklearn")) && existsSync(join(PYLIBS, "numpy"));
if (!hasGbdt) console.warn("[experiment-variant] GBDT + MLP in one dev report SKIPPED: scikit-learn is not in tools/baselines/.pylibs");

(hasGbdt ? describe : describe.skip)("the MLP's OOF bundle and the GBDT's go through the same evaluate", () => {
  it("both land in one dev report, covering every dev unit, with the same scoring of a prediction bundle", async () => {
    const work = tmpDir("gp-gbdt-");
    const datasetDir = join(work, "dataset");
    mkdirSync(datasetDir);
    for (const [name, text] of Object.entries(datasetFiles(false))) writeFileSync(join(datasetDir, name), text);
    const gb = spawnSync("python3", [join(BASELINES, "gbdt/gbdt.py"), "--dataset", datasetDir, "--out", join(work, "gbdt"), "--folds", "3", "--inner-folds", "2", "--emit", "test"], {
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: PYLIBS, PYTHONDONTWRITEBYTECODE: "1", OMP_NUM_THREADS: "2" },
    });
    expect(gb.status, gb.stderr).toBe(0);
    const gbdtReport = JSON.parse(readFileSync(join(work, "gbdt", "gbdt-report.json"), "utf8")) as { tau_star: number; dev_oof_macro_page_f1_at_tau: number };

    const dataDir = tmpDir();
    const store = new ArtifactStore(dataPaths(dataDir).artifacts);
    const dataset = store.putFiles("Dataset", datasetFiles(false));
    const bundleFiles = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    const gbdt = store.putFiles("Bundle", bundleFiles(join(work, "gbdt", "bundle-dev-oof")));
    const base = variant(dataset, store.putJson("Bundle", { id: "heur", predictions: CV_ROWS.map((r) => ({ g: r.g, u: r.u, p: 0 })) }));
    const spec: PipelineSpec = {
      ...base,
      externals: { ...base.externals, gbdt: { type: "Bundle", id: gbdt } },
      stages: base.stages.filter((s) => s.id === "cv_s1" || s.id === "eval_dev").map((s) => (s.id === "eval_dev" ? { ...s, inputs: { ...s.inputs, baselines: [{ stage: "cv_s1", output: "oof" }, { external: "gbdt" }] } } : s)),
    };
    const run = await runPipeline(spec, { dataDir, plugins: plugins() });
    expect(run.stages.map((s) => `${s.stageId}:${s.status}${s.error ? ` (${s.error})` : ""}`)).toEqual(["cv_s1:ran", "eval_dev:ran"]);
    const dev = store.handle((run.stages[1]?.outputs as Record<string, Sha256>)["report"] as Sha256, "EvalReport").json() as EvalReport;
    expect(Object.keys(dev.intrinsic?.baselines ?? {}).sort()).toEqual(["gbdt", "mlp-s1"]);
    for (const id of ["gbdt", "mlp-s1"]) expect(dev.intrinsic?.baselines[id]?.coverage, id).toBe(1);
    const pages = dev.intrinsic?.per_group ?? [];
    expect(pages.every((g) => typeof g.f1_by_baseline?.["gbdt"] === "number" && typeof g.f1_by_baseline?.["mlp-s1"] === "number")).toBe(true);
    // evaluate reproduces the GBDT's own number up to its 6-decimal rounding of p (tools/baselines writes p rounded, tau* not)
    const evaluated = pages.reduce((a, g) => a + (g.f1_by_baseline?.["gbdt"] as number), 0) / pages.length;
    expect(Math.abs(evaluated - gbdtReport.dev_oof_macro_page_f1_at_tau)).toBeLessThan(0.02);
  }, 600_000);
});
