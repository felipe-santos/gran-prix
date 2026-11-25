import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { artifactId, stageCacheKey, type PipelineSpec, type Sha256 } from "@gran-prix/contracts";
import { afterAll, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  PipelineValidationError,
  dataPaths,
  defineStage,
  lineageOf,
  runPipeline,
  type StageReceipt,
  type StageStatus,
} from "../src/index.js";
import { cleanupTmp, countingPlugins, demoSpec, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

const statuses = (r: { stages: Array<{ stageId: string; status: StageStatus }> }): Record<string, StageStatus> =>
  Object.fromEntries(r.stages.map((s) => [s.stageId, s.status]));

const receipt = (dataDir: string, runId: string, stage: string): StageReceipt =>
  JSON.parse(readFileSync(join(dataPaths(dataDir).runs, runId, stage, "stage.json"), "utf8")) as StageReceipt;

describe("caching", () => {
  it("the second run is a 100% cache hit and executes nothing", async () => {
    const dataDir = tmpDir();
    const { plugins, calls, reset } = countingPlugins();
    const opts = { dataDir, plugins, budgetUSD: 5 };

    const first = await runPipeline(demoSpec(), opts);
    expect(first.ok).toBe(true);
    expect(first.counts).toMatchObject({ ran: 6, cached: 0, failed: 0 });
    expect([...calls.values()].reduce((a, b) => a + b, 0)).toBe(6);

    reset();
    const second = await runPipeline(demoSpec(), opts);
    expect(second.ok).toBe(true);
    expect(second.counts).toMatchObject({ ran: 0, cached: 6, failed: 0 });
    expect(calls.size).toBe(0); // no stage code ran
    expect(second.stages.map((s) => s.outputs)).toEqual(first.stages.map((s) => s.outputs));
  });

  it("changing one param re-runs only the affected downstream stages", async () => {
    const dataDir = tmpDir();
    const { plugins, calls, reset } = countingPlugins();
    const opts = { dataDir, plugins, budgetUSD: 5 };
    await runPipeline(demoSpec(), opts);
    reset();

    const r = await runPipeline(demoSpec({ a: "ALPHA" }), opts);
    expect(statuses(r)).toEqual({ emit_a: "ran", emit_b: "cached", join: "ran", label: "ran", tail: "ran", side: "cached" });
    expect([...calls.keys()].sort()).toEqual(["emit_a", "join", "label", "tail"]);
  });

  it("a var used by one stage re-runs that stage only", async () => {
    const dataDir = tmpDir();
    const { plugins } = countingPlugins();
    const opts = { dataDir, plugins, budgetUSD: 5 };
    await runPipeline(demoSpec(), opts);
    expect(statuses(await runPipeline(demoSpec({ price: 0.5 }), opts))).toEqual({
      emit_a: "cached", emit_b: "cached", join: "cached", label: "ran", tail: "cached", side: "cached",
    });
    expect(statuses(await runPipeline(demoSpec({ sep: "+" }), opts))).toEqual({
      emit_a: "cached", emit_b: "cached", join: "ran", label: "ran", tail: "cached", side: "cached",
    });
  });

  it("reverting a change hits the older cache entries again (nothing re-runs)", async () => {
    const dataDir = tmpDir();
    const { plugins, calls, reset } = countingPlugins();
    const opts = { dataDir, plugins, budgetUSD: 5 };
    await runPipeline(demoSpec(), opts);
    await runPipeline(demoSpec({ a: "other" }), opts);
    reset();
    const back = await runPipeline(demoSpec(), opts);
    expect(back.counts.ran).toBe(0);
    expect(calls.size).toBe(0);
  });

  it("--force re-runs every selected stage and produces the same artifact ids", async () => {
    const dataDir = tmpDir();
    const { plugins, calls, reset } = countingPlugins();
    const opts = { dataDir, plugins, budgetUSD: 5 };
    const first = await runPipeline(demoSpec(), opts);
    reset();
    const forced = await runPipeline(demoSpec(), { ...opts, force: true });
    expect(forced.counts).toMatchObject({ ran: 6, cached: 0 });
    expect(calls.size).toBe(6);
    expect(forced.stages.map((s) => s.outputs)).toEqual(first.stages.map((s) => s.outputs));
    expect(receipt(dataDir, forced.runId, "join")).toMatchObject({ status: "ran", cache_mode: "refresh", cache_hit: false });
  });

  it("stage-level cache modes: `refresh` always re-runs, `off` never reads or writes the cache", async () => {
    const dataDir = tmpDir();
    const { plugins, calls, reset } = countingPlugins();
    const spec = demoSpec();
    (spec.stages[0] as { cache?: string }).cache = "refresh";
    (spec.stages[1] as { cache?: string }).cache = "off";
    await runPipeline(spec, { dataDir, plugins, budgetUSD: 5 });
    reset();
    const again = await runPipeline(spec, { dataDir, plugins, budgetUSD: 5 });
    expect(statuses(again).emit_a).toBe("ran");
    expect(statuses(again).emit_b).toBe("ran");
    expect(statuses(again).join).toBe("cached"); // same input ids => hit
    expect([...calls.keys()].sort()).toEqual(["emit_a", "emit_b"]);
    expect(readdirSync(dataPaths(dataDir).cache).length).toBe(5); // emit_b has no cache entry
  });

  it("a cache entry whose artifact vanished is a miss, not a crash", async () => {
    const dataDir = tmpDir();
    const { plugins } = countingPlugins();
    const first = await runPipeline(demoSpec(), { dataDir, plugins, budgetUSD: 5 });
    const id = first.stages.find((s) => s.stageId === "emit_b")?.outputs["out"] as Sha256;
    const { rmSync } = await import("node:fs");
    rmSync(new ArtifactStore(dataPaths(dataDir).artifacts).dirOf(id), { recursive: true });
    const again = await runPipeline(demoSpec(), { dataDir, plugins, budgetUSD: 5 });
    expect(statuses(again).emit_b).toBe("ran");
  });
});

describe("--from / --to", () => {
  it("--from runs the stage and its downstream; upstream stages are resolved from the cache", async () => {
    const dataDir = tmpDir();
    const { plugins, calls, reset } = countingPlugins();
    const opts = { dataDir, plugins, budgetUSD: 5 };
    await runPipeline(demoSpec(), opts);
    reset();
    const r = await runPipeline(demoSpec(), { ...opts, from: "join", force: true });
    expect(statuses(r)).toEqual({ emit_a: "cached", emit_b: "cached", join: "ran", label: "ran", tail: "out-of-range", side: "out-of-range" });
    expect([...calls.keys()].sort()).toEqual(["join", "label"]);
  });

  it("--to stops after the stage (and runs only its ancestors)", async () => {
    const dataDir = tmpDir();
    const { plugins, calls } = countingPlugins();
    const r = await runPipeline(demoSpec(), { dataDir, plugins, budgetUSD: 5, to: "join" });
    expect(statuses(r)).toEqual({ emit_a: "ran", emit_b: "ran", join: "ran", label: "out-of-range", tail: "out-of-range", side: "out-of-range" });
    expect(calls.has("label")).toBe(false);
    expect(r.ok).toBe(true);
  });

  it("--from X --to Y runs the slice between them", async () => {
    const dataDir = tmpDir();
    const { plugins } = countingPlugins();
    const opts = { dataDir, plugins, budgetUSD: 5 };
    await runPipeline(demoSpec(), opts);
    const r = await runPipeline(demoSpec(), { ...opts, from: "join", to: "join", force: true });
    expect(statuses(r)).toMatchObject({ emit_a: "cached", emit_b: "cached", join: "ran", label: "out-of-range" });
  });

  it("--from with an upstream stage that was never run fails before running anything", async () => {
    const dataDir = tmpDir();
    const { plugins, calls } = countingPlugins();
    const r = await runPipeline(demoSpec(), { dataDir, plugins, budgetUSD: 5, from: "join" });
    expect(r.ok).toBe(false);
    expect(statuses(r).emit_a).toBe("failed");
    expect(r.stages.find((s) => s.stageId === "emit_a")?.error).toMatch(/no cached output/);
    expect(statuses(r).join).toBe("skipped");
    expect(calls.size).toBe(0);
  });

  it("rejects an unknown stage name", async () => {
    await expect(runPipeline(demoSpec(), { dataDir: tmpDir(), from: "nope" })).rejects.toThrow(/--from nope: no such stage/);
  });
});

describe("failures", () => {
  const failing = (gate = false): PipelineSpec => {
    const spec = demoSpec();
    spec.stages.splice(3, 2, // replace label + tail
      { id: "boom", kind: "evaluate", impl: "ts:demo.fail@1.0.0", params: { message: "kaboom" }, inputs: { in: { stage: "join", output: "out" } }, ...(gate ? { gate: true } : {}) },
      { id: "after", kind: "extract", impl: "ts:demo.concat@1.0.0", params: {}, inputs: { parts: [{ stage: "boom", output: "out" }] } },
    );
    return spec;
  };

  it("a failing stage leaves a failed receipt, skips its downstream and the run is not ok", async () => {
    const dataDir = tmpDir();
    const { plugins, calls } = countingPlugins();
    const r = await runPipeline(failing(), { dataDir, plugins });
    expect(r.ok).toBe(false);
    expect(statuses(r)).toEqual({ emit_a: "ran", emit_b: "ran", join: "ran", boom: "failed", after: "skipped", side: "ran" });
    expect(calls.has("after")).toBe(false);
    const failed = receipt(dataDir, r.runId, "boom");
    expect(failed).toMatchObject({ status: "failed", error: { name: "Error", message: "kaboom" }, outputs: [] });
    expect(failed.cache_key).toMatch(/^sha256:/);
    expect(receipt(dataDir, r.runId, "after")).toMatchObject({ status: "skipped", reason: expect.stringContaining("boom") });
    // nothing was cached for the failed stage
    expect(readdirSync(dataPaths(dataDir).cache).length).toBe(4);
  });

  it("a failure is not cached: after the fix only the failed stage and its downstream run", async () => {
    const dataDir = tmpDir();
    const { plugins } = countingPlugins();
    await runPipeline(failing(), { dataDir, plugins });
    const fixed = failing();
    (fixed.stages[3] as { params: Record<string, unknown> }).params = { fail: false };
    const r = await runPipeline(fixed, { dataDir, plugins });
    expect(r.ok).toBe(true);
    expect(statuses(r)).toEqual({ emit_a: "cached", emit_b: "cached", join: "cached", boom: "ran", after: "ran", side: "cached" });
  });

  it("a gate stage aborts the run: even independent stages after it are skipped", async () => {
    const dataDir = tmpDir();
    const { plugins } = countingPlugins();
    const r = await runPipeline(failing(true), { dataDir, plugins });
    expect(statuses(r)).toMatchObject({ boom: "failed", after: "skipped", side: "skipped" });
    expect(receipt(dataDir, r.runId, "side").reason).toMatch(/aborted by gate stage "boom"/);
  });

  it("output contract violations fail the stage (missing port, unknown port, wrong arity)", async () => {
    const base = { kind: "collect" as const, inputs: [], runtime: "node" as const, determinism: "pure" as const, params_schema: { type: "object" } };
    const mk = (impl: string, outputs: Array<{ name: string; type: "Bundle"; many?: boolean }>, run: () => never) =>
      defineStage({ ...base, impl, outputs }, run);
    const bad = [
      mk("ts:t.missing@1.0.0", [{ name: "out", type: "Bundle" }], (() => ({})) as never),
      mk("ts:t.unknown@1.0.0", [{ name: "out", type: "Bundle" }], (() => ({ out: { json: 1 }, extra: { json: 2 } })) as never),
      mk("ts:t.arity@1.0.0", [{ name: "out", type: "Bundle", many: true }], (() => ({ out: { json: 1 } })) as never),
    ];
    for (const p of bad) {
      const spec: PipelineSpec = {
        format: "gran-prix.pipeline-spec", format_version: "1.0.0", name: "t",
        stages: [{ id: "s", kind: "collect", impl: p.spec.impl, params: {}, inputs: {} }],
      };
      const r = await runPipeline(spec, { dataDir: tmpDir(), plugins: [p] });
      expect(r.ok, p.spec.impl).toBe(false);
      expect(r.stages[0]?.status).toBe("failed");
    }
  });
});

describe("validation happens before anything runs", () => {
  const stageBase = { kind: "collect" as const, inputs: {} };
  const wrap = (stages: PipelineSpec["stages"]): PipelineSpec => ({ format: "gran-prix.pipeline-spec", format_version: "1.0.0", name: "t", stages });

  it("rejects an unknown impl, bad params and wrong port wiring, writing nothing", async () => {
    const dataDir = join(tmpDir(), "data");
    const cases: Array<[PipelineSpec, RegExp]> = [
      [wrap([{ id: "a", ...stageBase, impl: "ts:nope@1.0.0", params: {} }]), /unknown implementation/],
      [wrap([{ id: "a", ...stageBase, impl: "ts:demo.emit-json@1.0.0", params: {} }]), /value/],
      [wrap([{ id: "a", ...stageBase, impl: "ts:demo.emit-json@1.0.0", params: { value: 1, extra: true } }]), /additional/],
      [wrap([{ id: "a", ...stageBase, impl: "ts:demo.concat@1.0.0", params: {} }]), /required input port "parts"/],
      [wrap([{ id: "a", ...stageBase, impl: "ts:demo.emit-json@1.0.0", params: { value: "${vars.missing}" } }]), /unknown variable/],
    ];
    for (const [spec, re] of cases) {
      const err = await runPipeline(spec, { dataDir }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PipelineValidationError);
      expect((err as PipelineValidationError).issues.map((i) => i.message).join("\n")).toMatch(re);
    }
    expect(existsSync(dataDir)).toBe(false);
  });

  it("rejects a cycle", async () => {
    const spec = wrap([
      { id: "a", kind: "extract", impl: "ts:demo.concat@1.0.0", params: {}, inputs: { parts: [{ stage: "b", output: "out" }] } },
      { id: "b", kind: "extract", impl: "ts:demo.concat@1.0.0", params: {}, inputs: { parts: [{ stage: "a", output: "out" }] } },
    ]);
    await expect(runPipeline(spec, { dataDir: tmpDir() })).rejects.toThrow(/cycle/i);
  });
});

describe("the ledger inside a run", () => {
  it("blocks overspend: the stage fails, the cap is never passed, and a reject is logged", async () => {
    const dataDir = tmpDir();
    const { plugins } = countingPlugins();
    // 2 calls x $0.25 = $0.50 needed; cap $0.40: the 2nd reservation is refused.
    const r = await runPipeline(demoSpec(), { dataDir, plugins, budgetUSD: 0.4 });
    expect(r.ok).toBe(false);
    expect(statuses(r)).toMatchObject({ label: "failed", tail: "ran" });
    expect(r.stages.find((s) => s.stageId === "label")?.error).toMatch(/BudgetExceededError: budget cap exceeded/);
    const lines = readFileSync(dataPaths(dataDir).ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { event: string; cost_usd?: number });
    expect(lines.map((l) => l.event)).toEqual(["reserve", "commit", "reject"]);
    const spent = lines.filter((l) => l.event === "commit").reduce((a, l) => a + (l.cost_usd ?? 0), 0);
    expect(spent).toBeLessThanOrEqual(0.4);
    expect(receipt(dataDir, r.runId, "label")).toMatchObject({ status: "failed", cost_usd: 0.25 });
  });

  it("the default budget is 0: a paid stage cannot run without an explicit cap", async () => {
    const r = await runPipeline(demoSpec(), { dataDir: tmpDir() });
    expect(statuses(r).label).toBe("failed");
  });

  it("a cache hit spends nothing: the second run adds no ledger entries", async () => {
    const dataDir = tmpDir();
    const { plugins } = countingPlugins();
    await runPipeline(demoSpec(), { dataDir, plugins, budgetUSD: 5 });
    const before = readFileSync(dataPaths(dataDir).ledger, "utf8");
    await runPipeline(demoSpec(), { dataDir, plugins, budgetUSD: 5 });
    expect(readFileSync(dataPaths(dataDir).ledger, "utf8")).toBe(before);
  });
});

describe("artifacts, receipts and lineage", () => {
  it("artifact ids are stable across runs, data dirs and --force, and equal the canonical hash of the content", async () => {
    const { plugins } = countingPlugins();
    const a = await runPipeline(demoSpec(), { dataDir: tmpDir(), plugins, budgetUSD: 5, runId: "run-A" });
    const b = await runPipeline(demoSpec(), { dataDir: tmpDir(), plugins, budgetUSD: 5, runId: "run-B" });
    expect(b.stages.map((s) => s.outputs)).toEqual(a.stages.map((s) => s.outputs));
    expect(b.stages.map((s) => s.cacheKey)).toEqual(a.stages.map((s) => s.cacheKey));
    expect(a.stages.find((s) => s.stageId === "emit_a")?.outputs["out"]).toBe(artifactId({ value: "alpha" }));
    expect(a.stages.find((s) => s.stageId === "join")?.outputs["out"]).toBe(artifactId({ value: "alpha-beta", n: 2 }));
  });

  it("writes a stage.json receipt per stage with inputs, outputs, cache key, duration and impl version", async () => {
    const dataDir = tmpDir();
    const { plugins } = countingPlugins();
    const r = await runPipeline(demoSpec(), { dataDir, plugins, budgetUSD: 5, runId: "run-R" });
    const joined = receipt(dataDir, "run-R", "join");
    expect(joined).toMatchObject({ format: "gran-prix.stage-receipt", run_id: "run-R", stage_id: "join", impl: "ts:demo.concat@1.0.0", impl_version: "1.0.0", status: "ran", cache_hit: false });
    expect(joined.inputs.map((i) => [i.port, i.index])).toEqual([["parts", 0], ["parts", 1]]);
    expect(joined.outputs).toEqual([{ port: "out", artifact_id: r.stages[2]?.outputs["out"] }]);
    expect(joined.duration_ms).toBeGreaterThanOrEqual(0);
    expect(joined.tool_versions.node).toBe(process.version);

    // cache key = the contract's stageCacheKey over the resolved params and the input ids
    const a = r.stages[0]?.outputs["out"] as Sha256;
    const b = r.stages[1]?.outputs["out"] as Sha256;
    expect(joined.cache_key).toBe(
      stageCacheKey({ impl: "ts:demo.concat@1.0.0", kind: "extract", params: { separator: "-" }, inputIds: { parts: [a, b] } }),
    );
    expect(joined.params_sha256).toBe(artifactId({ separator: "-" }));

    const summary = JSON.parse(readFileSync(join(dataDir, "runs", "run-R", "run.json"), "utf8")) as { ok: boolean; counts: Record<string, number> };
    expect(summary).toMatchObject({ ok: true, counts: { ran: 6 } });
  });

  it("a cached stage still gets a receipt in the new run, marked cache_hit", async () => {
    const dataDir = tmpDir();
    const { plugins } = countingPlugins();
    await runPipeline(demoSpec(), { dataDir, plugins, budgetUSD: 5, runId: "run-1" });
    await runPipeline(demoSpec(), { dataDir, plugins, budgetUSD: 5, runId: "run-2" });
    expect(receipt(dataDir, "run-2", "join")).toMatchObject({ status: "cached", cache_hit: true, run_id: "run-2" });
  });

  it("stores provenance sidecars and lineageOf walks them up to the producers", async () => {
    const dataDir = tmpDir();
    const { plugins } = countingPlugins();
    const r = await runPipeline(demoSpec(), { dataDir, plugins, budgetUSD: 5, runId: "run-L" });
    const store = new ArtifactStore(dataPaths(dataDir).artifacts);
    const labelOut = r.stages.find((s) => s.stageId === "label")?.outputs["out"] as Sha256;
    const node = lineageOf(store, labelOut);
    expect(node.producedBy).toMatchObject({ stage_id: "label", run_id: "run-L" });
    expect(node.inputs.map((i) => [i.port, i.node.producedBy?.stage_id])).toEqual([["in", "join"]]);
    const join = node.inputs[0]?.node;
    expect(join?.inputs.map((i) => i.node.producedBy?.stage_id)).toEqual(["emit_a", "emit_b"]);
    expect(store.meta(labelOut).provenance?.pipeline_spec_id).toBe(r.specId);
    expect(store.verify(labelOut)).toBe(true);
  });

  it("`node+wasm` stages put the wasm sha in the cache key: another binary re-runs them", async () => {
    const wasmy = defineStage(
      { kind: "train", impl: "ts:t.wasmy@1.0.0", inputs: [], outputs: [{ name: "out", type: "Bundle" }], params_schema: { type: "object", properties: { seed: { type: "integer" } } }, runtime: "node+wasm", determinism: "seeded" },
      () => ({ out: { json: { ok: true } } }),
    );
    const spec: PipelineSpec = { format: "gran-prix.pipeline-spec", format_version: "1.0.0", name: "w", stages: [{ id: "t", kind: "train", impl: "ts:t.wasmy@1.0.0", params: { seed: 1 }, inputs: {} }] };
    const dataDir = tmpDir();
    const sha = (c: string): Sha256 => `sha256:${c.repeat(64)}`;
    const one = await runPipeline(spec, { dataDir, plugins: [wasmy], wasmSha: () => sha("a") });
    const two = await runPipeline(spec, { dataDir, plugins: [wasmy], wasmSha: () => sha("a") });
    const three = await runPipeline(spec, { dataDir, plugins: [wasmy], wasmSha: () => sha("b") });
    expect([one.stages[0]?.status, two.stages[0]?.status, three.stages[0]?.status]).toEqual(["ran", "cached", "ran"]);
    expect(one.stages[0]?.outputs).toEqual(three.stages[0]?.outputs); // same content, same id
    expect(receipt(dataDir, three.runId, "t").tool_versions.wasm_sha256).toBe(sha("b"));
  });

  it("externals: file content is part of the cache key; file-set artifacts are stored and verifiable", async () => {
    const root = tmpDir();
    const dataDir = tmpDir();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, "urls.csv"), "a.example\nb.example\n");
    const spec: PipelineSpec = {
      format: "gran-prix.pipeline-spec", format_version: "1.0.0", name: "ext",
      externals: { urls: { type: "Bundle", path: "urls.csv" } },
      stages: [{ id: "files", kind: "dataset", impl: "ts:demo.emit-files@1.0.0", params: { files: { "a.txt": "A", "dir/b.txt": "B" } }, inputs: {} }],
    };
    const fileStage = defineStage(
      { kind: "extract", impl: "ts:t.readurls@1.0.0", inputs: [{ name: "urls", type: "Bundle" }], outputs: [{ name: "out", type: "Bundle" }], params_schema: { type: "object" }, runtime: "node", determinism: "pure" },
      (ctx) => ({ out: { json: { text: new TextDecoder().decode((ctx.inputs["urls"] as { file(p: string): Uint8Array }).file("urls.csv")) } } }),
    );
    const read: PipelineSpec = { ...spec, stages: [{ id: "read", kind: "extract", impl: "ts:t.readurls@1.0.0", params: {}, inputs: { urls: { external: "urls" } } }] };
    const plugins = [...countingPlugins().plugins, fileStage];

    const r1 = await runPipeline(read, { dataDir, plugins, root });
    const r2 = await runPipeline(read, { dataDir, plugins, root });
    writeFileSync(join(root, "urls.csv"), "a.example\nb.example\nc.example\n");
    const r3 = await runPipeline(read, { dataDir, plugins, root });
    expect([r1.stages[0]?.status, r2.stages[0]?.status, r3.stages[0]?.status]).toEqual(["ran", "cached", "ran"]);

    const f = await runPipeline(spec, { dataDir, plugins, root });
    const id = f.stages[0]?.outputs["out"] as Sha256;
    const store = new ArtifactStore(dataPaths(dataDir).artifacts);
    expect(store.handle(id, "Bundle").files()).toEqual(["a.txt", "dir/b.txt"]);
    expect(store.verify(id)).toBe(true);
  });
});
