// Runner: `StageContext.root` and externals that are directories (E1 gate, wave 4).
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PipelineSpec } from "@gran-prix/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactStore, dataPaths, defineStage, runPipeline, type RunSummary, type StagePlugin } from "../src/index.js";
import { ALL_STAGES } from "../src/stages/index.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const ENV = { format: "gran-prix.pipeline-spec", format_version: "1.0.0" } as const;

/** Lists what a stage sees: its `ctx.root` and every file of its `Dataset` input with the size. */
const probe = defineStage(
  {
    kind: "dataset",
    impl: "ts:test.probe@1.0.0",
    inputs: [{ name: "dataset", type: "Dataset" }],
    outputs: [{ name: "out", type: "Bundle" }],
    params_schema: { type: "object", additionalProperties: false },
    runtime: "node",
    determinism: "pure",
  },
  (ctx) => {
    const input = ctx.inputs["dataset"] as { files(): string[]; file(p: string): Uint8Array };
    return { out: { files: { "seen.json": JSON.stringify({ root: ctx.root, files: input.files().map((p) => [p, input.file(p).length]) }) } } };
  },
);

/** Records `ctx.root` only (no inputs). */
const rootOnly = defineStage(
  {
    kind: "collect",
    impl: "ts:test.root@1.0.0",
    inputs: [],
    outputs: [{ name: "out", type: "Bundle" }],
    params_schema: { type: "object", additionalProperties: false },
    runtime: "node",
    determinism: "pure",
  },
  (ctx) => ({ out: { files: { "root.txt": ctx.root } } }),
);

const seenOf = (dataDir: string, r: RunSummary): { root: string; files: Array<[string, number]> } => {
  const id = r.stages[0]?.outputs["out"];
  if (typeof id !== "string") throw new Error("no output");
  return JSON.parse(readFileSync(join(dataPaths(dataDir).artifacts, id.replace(":", "-"), "files", "seen.json"), "utf8")) as { root: string; files: Array<[string, number]> };
};

function probeSpec(path: string, id?: string): PipelineSpec {
  return {
    ...ENV,
    name: "dir-external",
    externals: { data: { type: "Dataset", path, ...(id ? { id: id as never } : {}) } },
    stages: [{ id: "probe", kind: "dataset", impl: "ts:test.probe@1.0.0", params: {}, inputs: { dataset: { external: "data" } } }],
  };
}

/** A small directory-shaped artifact: nested files, bytes, an empty-named sibling order that must not matter. */
function makeDir(root: string, over: Record<string, string> = {}): string {
  const dir = join(root, "ds");
  mkdirSync(join(dir, "sub", "deeper"), { recursive: true });
  const files: Record<string, string> = { "manifest.json": '{"a":1}', "train.jsonl": "x\ny\n", "sub/b.txt": "bee", "sub/deeper/c.bin": "cee", ...over };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

describe("StageContext.root", () => {
  it("is RunOptions.root, resolved; the working directory when omitted", async () => {
    const a = tmpDir();
    const spec: PipelineSpec = { ...ENV, name: "root", stages: [{ id: "r", kind: "collect", impl: "ts:test.root@1.0.0", params: {}, inputs: {} }] };
    const read = (dataDir: string, r: RunSummary): string => {
      const id = r.stages[0]?.outputs["out"] as string;
      return readFileSync(join(dataPaths(dataDir).artifacts, id.replace(":", "-"), "files", "root.txt"), "utf8");
    };
    const withRoot = await runPipeline(spec, { dataDir: a, plugins: [rootOnly], root: REPO });
    expect(read(a, withRoot)).toBe(REPO.replace(/\/$/, ""));
    const b = tmpDir();
    const without = await runPipeline(spec, { dataDir: b, plugins: [rootOnly] });
    expect(read(b, without)).toBe(process.cwd());
  });

  it("is the base of relative external paths (a directory below it) and the stage sees the same root", async () => {
    const base = tmpDir();
    makeDir(base);
    const dataDir = tmpDir();
    const r = await runPipeline(probeSpec("ds"), { dataDir, plugins: [probe], root: base });
    expect(r.ok).toBe(true);
    expect(seenOf(dataDir, r).root).toBe(base);
  });
});

describe("directory externals", () => {
  it("become one file-set artifact keyed by relative path; ids do not depend on the data dir, the root or the run", async () => {
    const base = tmpDir();
    const dir = makeDir(base);
    const d1 = tmpDir();
    const d2 = tmpDir();
    const r1 = await runPipeline(probeSpec(dir), { dataDir: d1, plugins: [probe], runId: "one" });
    expect(seenOf(d1, r1).files).toEqual([["manifest.json", 7], ["sub/b.txt", 3], ["sub/deeper/c.bin", 3], ["train.jsonl", 4]]);
    // the same bytes in another place, another data dir and run id: the same external id, the same stage output ids
    const other = tmpDir();
    const copy = join(other, "elsewhere");
    cpSync(dir, copy, { recursive: true });
    const r2 = await runPipeline(probeSpec("elsewhere"), { dataDir: d2, plugins: [probe], runId: "two", root: other });
    expect(r2.stages[0]?.cacheKey).toBe(r1.stages[0]?.cacheKey);
    expect(r2.stages[0]?.status).toBe("ran"); // a fresh data dir
    // the artifact itself is in the store as a file set of type Dataset
    const receipt = JSON.parse(readFileSync(join(dataPaths(d1).runs, "one", "probe", "stage.json"), "utf8")) as { inputs: Array<{ artifact_id: string }> };
    const meta = new ArtifactStore(dataPaths(d1).artifacts).meta(receipt.inputs[0]?.artifact_id as never);
    expect(meta).toMatchObject({ kind: "files", type: "Dataset" });
  });

  it("the cache follows the content: a changed file re-runs, the same bytes hit", async () => {
    const base = tmpDir();
    const dir = makeDir(base);
    const dataDir = tmpDir();
    const a = await runPipeline(probeSpec(dir), { dataDir, plugins: [probe] });
    const b = await runPipeline(probeSpec(dir), { dataDir, plugins: [probe] });
    expect([a.stages[0]?.status, b.stages[0]?.status]).toEqual(["ran", "cached"]);
    writeFileSync(join(dir, "sub", "b.txt"), "BEE");
    const c = await runPipeline(probeSpec(dir), { dataDir, plugins: [probe] });
    expect(c.stages[0]?.status).toBe("ran");
    expect(c.stages[0]?.cacheKey).not.toBe(a.stages[0]?.cacheKey);
  });

  it("can be pinned by id: the right id passes, another one is refused with both ids", async () => {
    const base = tmpDir();
    const dir = makeDir(base);
    const probeRun = await runPipeline(probeSpec(dir), { dataDir: tmpDir(), plugins: [probe] });
    expect(probeRun.ok).toBe(true);
    // the external's id is an input of the stage receipt
    const dataDir = tmpDir();
    const ok = await runPipeline(probeSpec(dir), { dataDir, plugins: [probe], runId: "pin" });
    const receipt = JSON.parse(readFileSync(join(dataPaths(dataDir).runs, "pin", "probe", "stage.json"), "utf8")) as { inputs: Array<{ artifact_id: string }> };
    const id = receipt.inputs[0]?.artifact_id as string;
    expect(ok.ok).toBe(true);
    expect((await runPipeline(probeSpec(dir, id), { dataDir: tmpDir(), plugins: [probe] })).ok).toBe(true);
    const bad = await runPipeline(probeSpec(dir, `sha256:${"0".repeat(64)}`), { dataDir: tmpDir(), plugins: [probe] });
    expect(bad.ok).toBe(false);
    expect(bad.stages[0]?.error).toMatch(/hashes to sha256:[0-9a-f]{64}, the spec pins sha256:0{64}/);
  });

  it("an empty directory is an error, not an empty artifact", async () => {
    const base = tmpDir();
    mkdirSync(join(base, "empty"));
    const r = await runPipeline(probeSpec(join(base, "empty")), { dataDir: tmpDir(), plugins: [probe] });
    expect(r.ok).toBe(false);
    expect(r.stages[0]?.error).toMatch(/holds no file/);
  });

  it("start a real run from an existing ModelPackage: the package stage verifies it and bundles it", async () => {
    const spec: PipelineSpec = {
      ...ENV,
      name: "from-model",
      externals: { model: { type: "ModelPackage", path: "packages/contracts/fixtures/valid/model-package" } },
      stages: [{ id: "package", kind: "package", impl: "ts:package.bundle@1.0.0", params: {}, inputs: { model: { external: "model" } } }],
    };
    const dataDir = tmpDir();
    const plugins: StagePlugin[] = ALL_STAGES;
    const first = await runPipeline(spec, { dataDir, plugins, root: REPO, runId: "a" });
    expect(first.stages[0]?.error).toBeUndefined();
    expect(first.ok).toBe(true);
    const again = await runPipeline(spec, { dataDir, plugins, root: REPO, runId: "b" });
    expect(again.stages[0]?.status).toBe("cached");
    expect(again.stages[0]?.outputs).toEqual(first.stages[0]?.outputs);
  });
});
