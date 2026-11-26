import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Of, validate, type PipelineSpec, type Sha256 } from "@gran-prix/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  dataPaths,
  defineStage,
  runPipeline,
  type RunSummary,
  type StagePlugin,
  type StageReceipt,
} from "../src/index.js";
import { runSelfTest } from "../src/stages/bundle.js";
import { ALL_STAGES } from "../src/stages/index.js";
import { createTrainStage, defaultGpTrainPath } from "../src/stages/train.js";
import { packageStage } from "../src/stages/package.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURES = join(ROOT, "packages/contracts/fixtures/valid");

// --------------------------------------------------------------------- fixtures

/** Emits the contracts' valid dataset fixture (plus its feature schema) as a `Dataset` artifact. */
const emitDataset = defineStage(
  {
    kind: "dataset",
    impl: "ts:test.emit-dataset@1.0.0",
    inputs: [],
    outputs: [{ name: "dataset", type: "Dataset" }],
    params_schema: { type: "object", additionalProperties: false },
    runtime: "node",
    determinism: "pure",
  },
  () => {
    const files: Record<string, Uint8Array> = {};
    for (const f of ["manifest.json", "train.jsonl", "val.jsonl", "test.jsonl"]) {
      files[f] = new Uint8Array(readFileSync(join(FIXTURES, "dataset", f)));
    }
    files["feature-schema.json"] = new Uint8Array(readFileSync(join(FIXTURES, "feature-schema.json")));
    return { dataset: { files } };
  },
);

function spec(over: { seed?: number } = {}): PipelineSpec {
  return {
    format: "gran-prix.pipeline-spec",
    format_version: "1.0.0",
    name: "engine-mini",
    externals: { config: { type: "TrainConfig", path: join(FIXTURES, "train-config.json") } },
    stages: [
      { id: "dataset", kind: "dataset", impl: "ts:test.emit-dataset@1.0.0", params: {}, inputs: {} },
      {
        id: "train",
        kind: "train",
        impl: "rust:train.gp-train@1.0.0",
        params: { seed: over.seed ?? 42 },
        inputs: { dataset: { stage: "dataset", output: "dataset" }, config: { external: "config" } },
      },
      { id: "package", kind: "package", impl: "ts:package.bundle@1.0.0", params: {}, inputs: { model: { stage: "train", output: "model" } } },
    ],
  };
}

let binA = "";
let binB = "";

beforeAll(() => {
  const real = defaultGpTrainPath();
  if (!existsSync(real)) {
    const r = spawnSync("cargo", ["build", "--release", "-p", "gp-train"], { cwd: ROOT, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`cannot build gp-train: ${r.stderr.slice(-1500)}`);
  }
  // Private copies: the shared target may be rebuilt by someone else while tests run.
  const dir = tmpDir("gp-bin-");
  binA = join(dir, "gp-train-a");
  binB = join(dir, "gp-train-b");
  copyFileSync(real, binA);
  copyFileSync(real, binB);
  appendFileSync(binB, Buffer.from([0])); // "rebuilt": other bytes, same behavior
}, 600_000);

interface Counted {
  plugins: StagePlugin[];
  calls: string[];
}

/** emit-dataset + train(binary) + package, recording which stages actually executed. */
function plugins(binary: string): Counted {
  const calls: string[] = [];
  const count = (p: StagePlugin): StagePlugin => ({
    ...p,
    run: (ctx) => {
      calls.push(ctx.stageId);
      return p.run(ctx);
    },
  });
  return { calls, plugins: [emitDataset, createTrainStage({ binary: () => binary }), packageStage].map(count) };
}

const statuses = (r: RunSummary): Record<string, string> => Object.fromEntries(r.stages.map((s) => [s.stageId, s.status]));
const receipt = (dataDir: string, runId: string, stage: string): StageReceipt =>
  JSON.parse(readFileSync(join(dataPaths(dataDir).runs, runId, stage, "stage.json"), "utf8")) as StageReceipt;

// ------------------------------------------------------------------------ tests

describe("registration", () => {
  it("train and package are registered with the canonical ports and valid StageKindSpecs", () => {
    const train = ALL_STAGES.find((s) => s.spec.impl === "rust:train.gp-train@1.0.0");
    const pack = ALL_STAGES.find((s) => s.spec.impl === "ts:package.bundle@1.0.0");
    expect(train?.spec).toMatchObject({ kind: "train", runtime: "rust", determinism: "seeded" });
    expect(train?.spec.inputs.map((p) => [p.name, p.type])).toEqual([["dataset", "Dataset"], ["config", "TrainConfig"]]);
    expect(train?.spec.outputs.map((p) => [p.name, p.type])).toEqual([["model", "ModelPackage"]]);
    expect(pack?.spec).toMatchObject({ kind: "package", runtime: "node+wasm", determinism: "pure" });
    expect(pack?.spec.inputs.map((p) => [p.name, p.type])).toEqual([["model", "ModelPackage"]]);
    expect(pack?.spec.outputs.map((p) => [p.name, p.type])).toEqual([["bundle", "Bundle"]]);
    for (const p of [train, pack]) expect(validate("stage-kind-spec", p?.spec).ok).toBe(true);
  });
});

describe("train -> package mini pipeline", () => {
  it("runs, then a second run is a 100% cache hit that executes nothing", async () => {
    const dataDir = tmpDir();
    const a = plugins(binA);
    const first = await runPipeline(spec(), { dataDir, plugins: a.plugins, runId: "run-1" });
    expect(first.ok, JSON.stringify(first.stages.map((s) => s.error))).toBe(true);
    expect(first.counts).toMatchObject({ ran: 3, cached: 0, failed: 0 });
    expect(a.calls).toEqual(["dataset", "train", "package"]);

    a.calls.length = 0;
    const second = await runPipeline(spec(), { dataDir, plugins: a.plugins, runId: "run-2" });
    expect(second.counts).toMatchObject({ ran: 0, cached: 3, failed: 0 });
    expect(a.calls).toEqual([]);
    expect(second.stages.map((s) => s.outputs)).toEqual(first.stages.map((s) => s.outputs));
  });

  it("the ModelPackage passes the nine checks and the bundle is complete with sha256 per file", async () => {
    const dataDir = tmpDir();
    const r = await runPipeline(spec(), { dataDir, plugins: plugins(binA).plugins, runId: "run-1" });
    const store = new ArtifactStore(dataPaths(dataDir).artifacts);
    const { loadModelPackage } = await import("@gran-prix/model");

    const model = store.handle(r.stages[1]?.outputs["model"] as Sha256, "ModelPackage");
    expect(model.files()).toEqual(expect.arrayContaining(["golden.json", "model.json", "network_def.json", "weights.f32le"]));
    const loaded = loadModelPackage(join(model.dir, "files"));
    expect(loaded.checks.map((c) => c.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(loaded.manifest.provenance?.produced_by).toMatchObject({ stage_id: "train", cache_key: r.stages[1]?.cacheKey });
    loaded.dispose();

    const bundle = store.handle(r.stages[2]?.outputs["bundle"] as Sha256, "Bundle");
    expect(bundle.files()).toEqual(
      ["bundle.json", "golden.json", "model.generated.ts", "model.json", "network_def.json", "selftest.mjs", "train_report.json", "weights.f32le"].sort(),
    );
    const doc = JSON.parse(new TextDecoder().decode(bundle.file("bundle.json"))) as {
      model_id: string;
      files: Record<string, { sha256: string; bytes: number }>;
      self_test: { passed: boolean; cases: number };
    };
    expect(doc.model_id).toBe(loaded.modelId);
    expect(doc.self_test).toMatchObject({ passed: true });
    expect(doc.self_test.cases).toBeGreaterThan(0);
    expect(Object.keys(doc.files)).toEqual(bundle.files().filter((f) => f !== "bundle.json"));
    for (const [path, info] of Object.entries(doc.files)) {
      const bytes = bundle.file(path);
      expect({ path, sha256: sha256Of(bytes), bytes: bytes.length }).toEqual({ path, ...info });
    }
    expect(new TextDecoder().decode(bundle.file("model.generated.ts"))).toContain("export function predictLogitsBatch");
  });

  it("the bundle self-test passes when run on the stored files, and fails when golden.json is wrong", async () => {
    const dataDir = tmpDir();
    const r = await runPipeline(spec(), { dataDir, plugins: plugins(binA).plugins, runId: "run-1" });
    const store = new ArtifactStore(dataPaths(dataDir).artifacts);
    const bundle = store.handle(r.stages[2]?.outputs["bundle"] as Sha256, "Bundle");

    const out = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "selftest.mjs"], {
      cwd: join(bundle.dir, "files"),
      encoding: "utf8",
    });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/^selftest: PASS \(\d+ cases/);

    const files: Record<string, Uint8Array | string> = Object.fromEntries(bundle.files().map((f) => [f, bundle.file(f)]));
    expect(runSelfTest(files)).toMatch(/PASS/);
    const golden = JSON.parse(new TextDecoder().decode(bundle.file("golden.json")));
    golden.cases[0].score = [0.99];
    expect(() => runSelfTest({ ...files, "golden.json": JSON.stringify(golden) })).toThrow(/selftest: FAIL[\s\S]*case \S+ score\[0\]: got/);
  });

  it("is reproducible: a fresh data dir and another run id give byte-identical artifacts", async () => {
    const one = await runPipeline(spec(), { dataDir: tmpDir(), plugins: plugins(binA).plugins, runId: "alpha" });
    const two = await runPipeline(spec(), { dataDir: tmpDir(), plugins: plugins(binA).plugins, runId: "beta" });
    expect(two.stages.map((s) => s.outputs)).toEqual(one.stages.map((s) => s.outputs));
  });

  it("a different seed re-trains and re-packages, the dataset stays cached", async () => {
    const dataDir = tmpDir();
    const a = plugins(binA);
    await runPipeline(spec({ seed: 42 }), { dataDir, plugins: a.plugins });
    const r = await runPipeline(spec({ seed: 43 }), { dataDir, plugins: a.plugins });
    expect(statuses(r)).toEqual({ dataset: "cached", train: "ran", package: "ran" });
  });
});

describe("sample_weight reaches gp-train", () => {
  const rowConfig = (): Record<string, unknown> => {
    const { train_config_id: _id, ...base } = JSON.parse(readFileSync(join(FIXTURES, "train-config.json"), "utf8")) as Record<string, unknown>;
    return { ...base, format_version: "1.1.0", sample_weight: "row" };
  };
  /** The same pipeline with the TrainConfig given inline (`params.config`) instead of the external one. */
  const inline = (config: Record<string, unknown>, dataset = "ts:test.emit-dataset@1.0.0"): PipelineSpec => {
    const s = spec();
    const stages = s.stages.map((st) => {
      if (st.id === "dataset") return { ...st, impl: dataset };
      if (st.id === "train") return { ...st, params: { seed: 42, config }, inputs: { dataset: { stage: "dataset", output: "dataset" } } };
      return st;
    });
    const { externals: _e, ...rest } = s;
    return { ...rest, stages } as PipelineSpec;
  };
  const emitUnweighted = defineStage(
    { kind: "dataset", impl: "ts:test.emit-dataset-unweighted@1.0.0", inputs: [], outputs: [{ name: "dataset", type: "Dataset" }], params_schema: { type: "object", additionalProperties: false }, runtime: "node", determinism: "pure" },
    () => {
      const files: Record<string, Uint8Array> = {};
      for (const f of ["train.jsonl", "val.jsonl", "test.jsonl"]) files[f] = new Uint8Array(readFileSync(join(FIXTURES, "dataset", f)));
      const manifest = JSON.parse(readFileSync(join(FIXTURES, "dataset", "manifest.json"), "utf8")) as Record<string, unknown>;
      delete manifest["row_weight"];
      files["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest));
      files["feature-schema.json"] = new Uint8Array(readFileSync(join(FIXTURES, "feature-schema.json")));
      return { dataset: { files } };
    },
  );

  it('"row" trains with the dataset weights (the train report says so, the fit differs from "none")', async () => {
    const dataDir = tmpDir();
    const row = await runPipeline(inline(rowConfig()), { dataDir, plugins: plugins(binA).plugins, runId: "row" });
    expect(row.ok, JSON.stringify(row.stages.map((s) => s.error))).toBe(true);
    const none = await runPipeline(inline({ ...rowConfig(), sample_weight: "none" }), { dataDir, plugins: plugins(binA).plugins, runId: "none" });
    expect(none.ok).toBe(true);
    const store = new ArtifactStore(dataPaths(dataDir).artifacts);
    const report = (r: RunSummary): { sample_weight?: string } => JSON.parse(new TextDecoder().decode(store.handle(r.stages[1]?.outputs["model"] as Sha256, "ModelPackage").file("train_report.json"))) as { sample_weight?: string };
    expect(report(row).sample_weight).toBe("row");
    expect(report(none).sample_weight).toBeUndefined();
    expect(row.stages[1]?.outputs["model"]).not.toBe(none.stages[1]?.outputs["model"]);
  }, 120_000);

  it('"row" on a dataset without row_weight fails loudly instead of training unweighted', async () => {
    const r = await runPipeline(inline(rowConfig(), "ts:test.emit-dataset-unweighted@1.0.0"), {
      dataDir: tmpDir(),
      plugins: [emitUnweighted, ...plugins(binA).plugins.filter((p) => p.spec.impl !== "ts:test.emit-dataset@1.0.0")],
      runId: "loud",
    });
    expect(r.ok).toBe(false);
    expect(r.stages.find((s) => s.stageId === "train")?.error).toMatch(/row_weight/);
  }, 120_000);
});

describe("the gp-train binary is part of the cache key", () => {
  it("a rebuilt binary invalidates train and its downstream only", async () => {
    const dataDir = tmpDir();
    const first = await runPipeline(spec(), { dataDir, plugins: plugins(binA).plugins, runId: "with-a" });
    expect(statuses(first)).toEqual({ dataset: "ran", train: "ran", package: "ran" });

    const b = plugins(binB);
    const second = await runPipeline(spec(), { dataDir, plugins: b.plugins, runId: "with-b" });
    expect(statuses(second)).toEqual({ dataset: "cached", train: "ran", package: "ran" });
    expect(b.calls).toEqual(["train", "package"]);
    expect(second.stages[1]?.cacheKey).not.toBe(first.stages[1]?.cacheKey);

    // The same binary again hits the old entries; the receipts name the digest.
    const back = await runPipeline(spec(), { dataDir, plugins: plugins(binA).plugins, runId: "back-to-a" });
    expect(back.counts).toMatchObject({ ran: 0, cached: 3 });
    const shaA = sha256Of(new Uint8Array(readFileSync(binA)));
    const shaB = sha256Of(new Uint8Array(readFileSync(binB)));
    expect(shaA).not.toBe(shaB);
    expect(receipt(dataDir, "with-a", "train").tool_versions.tools).toEqual({ "gp-train": shaA });
    expect(receipt(dataDir, "with-b", "train").tool_versions.tools).toEqual({ "gp-train": shaB });
    expect(receipt(dataDir, "with-a", "dataset").tool_versions.tools).toBeUndefined();
    const store = new ArtifactStore(dataPaths(dataDir).artifacts);
    const meta = store.meta(first.stages[1]?.outputs["model"] as Sha256);
    expect((meta.provenance?.tool_versions as { tools?: unknown }).tools).toEqual({ "gp-train": shaA });
  });

  it("a missing binary fails the train stage with the build hint and skips the package", async () => {
    const r = await runPipeline(spec(), { dataDir: tmpDir(), plugins: plugins("/nonexistent/gp-train").plugins });
    expect(statuses(r)).toEqual({ dataset: "ran", train: "failed", package: "skipped" });
    expect(r.stages[1]?.error).toMatch(/gp-train binary not found.*cargo build --release -p gp-train/);
  });

  it("any plugin can pin a tool binary through toolDigests: another digest re-runs it, the same one hits", async () => {
    const dataDir = tmpDir();
    let runs = 0;
    const tool = (sha: Sha256): StagePlugin => ({
      ...defineStage(
        {
          kind: "extract",
          impl: "rust:test.tool@1.0.0",
          inputs: [],
          outputs: [{ name: "out", type: "Bundle" }],
          params_schema: { type: "object" },
          runtime: "rust",
          determinism: "pure",
        },
        () => ({ out: { json: { n: ++runs } } }),
      ),
      toolDigests: () => ({ tool: sha }),
    });
    const one: PipelineSpec = {
      format: "gran-prix.pipeline-spec",
      format_version: "1.0.0",
      name: "tool",
      stages: [{ id: "t", kind: "extract", impl: "rust:test.tool@1.0.0", params: {}, inputs: {} }],
    };
    const sha1 = sha256Of(new Uint8Array([1]));
    const sha2 = sha256Of(new Uint8Array([2]));
    expect((await runPipeline(one, { dataDir, plugins: [tool(sha1)] })).counts.ran).toBe(1);
    expect((await runPipeline(one, { dataDir, plugins: [tool(sha1)] })).counts.cached).toBe(1);
    expect((await runPipeline(one, { dataDir, plugins: [tool(sha2)] })).counts.ran).toBe(1);
    expect(runs).toBe(2);
  });
});
