// A dom-v0-like mini pipeline over the 6 synthetic fixtures with EVERY baseline wired into evaluate: Readability,
// Trafilatura, Defuddle and the router (predicted and oracle type) as `label_baselines`, then the offline GBDT as a
// `baselines` Bundle. Needs the Python sidecars (tools/baselines/.pylibs) and the gp-train binary; skipped otherwise.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalReport, PipelineSpec } from "@gran-prix/contracts";
import { afterAll, describe, expect, inject, it } from "vitest";
import { ArtifactStore, dataPaths, runPipeline, type StagePlugin } from "../src/index.js";
import { ALL_STAGES } from "../src/stages/index.js";
import { defaultGpTrainPath } from "../src/stages/train.js";
import { SNAP, corpusExternals, sidecarAvailable } from "./baselines-helpers.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const corpus = inject("corpusDir");
const NAMES = ["article-1", "article-2", "docs-1", "forum-1", "landing-1", "product-1"];
const ready = sidecarAvailable() && existsSync(defaultGpTrainPath());
if (!ready) console.warn("[baselines] mini pipeline SKIPPED: needs tools/baselines/.pylibs and the gp-train release binary");
const maybe = ready ? describe : describe.skip;

const BASELINE_NAMES = ["readability", "trafilatura", "defuddle", "router_predicted", "router_oracle"];
const truth = NAMES.map((n) => ({
  url_contains: `${n}.html`,
  rules: (JSON.parse(readFileSync(join(corpus, "truth", `${n}.json`), "utf8")) as { rules: unknown[] }).rules,
}));
// article-* share the domain news.example; every other page is its own domain
const OVERRIDES = { "news.example": "train", "docs-1.example": "train", "landing-1.example": "val", "forum-1.example": "test", "product-1.example": "test" };
const SCORE = { min_coverage: 0 };

function spec(ext: NonNullable<PipelineSpec["externals"]>, extraEval: boolean): PipelineSpec {
  const label = (id: string, impl: string, params: Record<string, unknown>) => ({ id, kind: "label" as const, impl, params, inputs: SNAP });
  return {
    format: "gran-prix.pipeline-spec",
    format_version: "1.0.0",
    name: "dom-v0-mini-baselines",
    vars: { seed: 42 },
    externals: ext,
    stages: [
      label("truth", "ts:label.truth@1.0.0", { pages: truth }),
      label("readability", "ts:label.heuristic@1.0.0", { labeler: "readability", ...SCORE }),
      label("trafilatura", "ts:label.trafilatura@1.0.0", SCORE),
      label("defuddle", "ts:label.defuddle@1.0.0", SCORE),
      label("router_predicted", "ts:label.router@1.0.0", SCORE),
      label("router_oracle", "ts:label.router@1.0.0", { ...SCORE, type_from: "category" }),
      { id: "merge", kind: "label", impl: "ts:label.merge@1.0.0", params: {}, inputs: { layers: [{ stage: "truth", output: "labels" }, { stage: "readability", output: "labels" }] } },
      {
        id: "dataset",
        kind: "dataset",
        impl: "ts:dataset.jsonl@1.0.0",
        params: { split: { seed: "mini", overrides: OVERRIDES } },
        inputs: { features: { external: "features" }, labels: { stage: "merge", output: "labels" }, schema: { external: "schema" }, snapshots: { external: "snapshots" } },
      },
      {
        id: "train",
        kind: "train",
        impl: "rust:train.gp-train@1.0.0",
        params: { seed: "${vars.seed}", name: "mini", task_name: "dom-main-content" },
        inputs: { dataset: { stage: "dataset", output: "dataset" }, config: { external: "train_config" } },
      },
      {
        id: "evaluate",
        kind: "evaluate",
        impl: "ts:evaluate.intrinsic@1.0.0",
        params: { seed: "${vars.seed}", split: "test", resamples: 100, gates: [], label_baseline: { names: BASELINE_NAMES } },
        inputs: {
          model: { stage: "train", output: "model" },
          dataset: { stage: "dataset", output: "dataset" },
          label_baselines: BASELINE_NAMES.map((id) => ({ stage: id, output: "labels" })),
        },
      },
      ...(extraEval
        ? [
            {
              id: "evaluate_gbdt",
              kind: "evaluate" as const,
              impl: "ts:evaluate.intrinsic@1.0.0",
              params: { seed: "${vars.seed}", split: "test", resamples: 100, gates: [], label_baseline: { names: BASELINE_NAMES }, reopen_reason: "test fixture: the same model is scored again on the same synthetic split with the GBDT bundle added" },
              inputs: {
                model: { stage: "train", output: "model" },
                dataset: { stage: "dataset", output: "dataset" },
                baselines: [{ external: "gbdt" }],
                label_baselines: BASELINE_NAMES.map((id) => ({ stage: id, output: "labels" })),
              },
            },
          ]
        : []),
    ],
  };
}

maybe("mini pipeline: every baseline in one evaluate report", () => {
  it("scores the model, five label baselines and the offline GBDT on the same test units", async () => {
    const dataDir = tmpDir();
    const ext = corpusExternals(corpus, dataDir);
    const store = new ArtifactStore(dataPaths(dataDir).artifacts);
    const base = { dataDir, plugins: ALL_STAGES as StagePlugin[], budgetUSD: 0, root: REPO };
    const withTrain = { ...ext, train_config: { type: "TrainConfig" as const, path: "pipelines/dom-v0.train-config.json" } };

    const first = await runPipeline(spec(withTrain, false), base);
    expect(first.stages.map((s) => s.error).filter(Boolean)).toEqual([]);
    expect(first.ok).toBe(true);
    const out = (r: typeof first, id: string, port: string) => r.stages.find((s) => s.stageId === id)!.outputs[port] as `sha256:${string}`;
    const report1 = store.handle(out(first, "evaluate", "report"), "EvalReport").json() as EvalReport;
    expect(Object.keys(report1.intrinsic?.baselines ?? {}).sort()).toEqual([...BASELINE_NAMES].sort());
    for (const [id, b] of Object.entries(report1.intrinsic?.baselines ?? {})) {
      expect(b.coverage, id).toBe(1); // min_coverage 0: nothing is discarded in the baselines' favour
      expect(b.overall.f1, id).toBeGreaterThanOrEqual(0);
    }

    // the GBDT: same dataset, dev only, test predictions as a Bundle
    const ds = store.handle(out(first, "dataset", "dataset"), "Dataset");
    const dsDir = join(tmpDir("gp-gbdt-ds-"), "dataset");
    mkdirSync(dsDir, { recursive: true });
    for (const f of ds.files()) writeFileSync(join(dsDir, f), ds.file(f));
    const outDir = join(tmpDir("gp-gbdt-out-"), "gbdt");
    const py = spawnSync("python3", [join(REPO, "tools/baselines/gbdt/gbdt.py"), "--dataset", dsDir, "--out", outDir, "--seed", "1", "--folds", "3", "--inner-folds", "2"], {
      env: { ...process.env, PYTHONPATH: join(REPO, "tools/baselines/.pylibs"), OMP_NUM_THREADS: "2" },
      encoding: "utf8",
    });
    expect(py.status, py.stderr).toBe(0);
    const bundle = { "predictions.jsonl": new Uint8Array(readFileSync(join(outDir, "bundle-test/predictions.jsonl"))), "system.json": new Uint8Array(readFileSync(join(outDir, "bundle-test/system.json"))) };
    const gbdtId = store.putFiles("Bundle", bundle);

    const second = await runPipeline(spec({ ...withTrain, gbdt: { type: "Bundle", id: gbdtId } }, true), base);
    expect(second.stages.map((s) => s.error).filter(Boolean)).toEqual([]);
    expect(second.counts.failed).toBe(0);
    const report2 = store.handle(out(second, "evaluate_gbdt", "report"), "EvalReport").json() as EvalReport;
    expect(Object.keys(report2.intrinsic?.baselines ?? {}).sort()).toEqual(["gbdt", ...BASELINE_NAMES].sort());
    expect(report2.intrinsic?.baselines["gbdt"]?.coverage).toBe(1);
    // the same test units for every system: the model's counts do not depend on the baselines
    expect(report2.intrinsic?.overall).toEqual(report1.intrinsic?.overall);
  }, 600_000); // gp-train + the nested GBDT CV in Python: minutes on a loaded machine
});
