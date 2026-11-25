// The blindness register (protocol 13): the test split is opened ONCE per (model, dataset); a second opening fails
// unless params.reopen_reason says why, and is registered either way. `dev` never touches the register.
import { readFileSync } from "node:fs";
import type { EvalReport, PipelineSpec, Sha256 } from "@gran-prix/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { runPipeline } from "../src/index.js";
import { OPENINGS_FILE, openingsPath, readOpenings, registerOpening, TestReopenedError } from "../src/stages/evaluate/openings.js";
import { EVALUATE_IMPL } from "../src/stages/evaluate/stage.js";
import { GROUPS, OP, ROWS, buildDataset, specWith, synthRows, world, type World } from "./evaluate-fixtures.js";
import { cleanupTmp } from "./helpers.js";

afterAll(cleanupTmp);

// Plain params: NO reopen_reason (the shared `stage()` helper adds one on purpose, see evaluate-fixtures.ts).
const plain = (params: Record<string, unknown>): PipelineSpec["stages"][number] => ({
  id: "eval",
  kind: "evaluate",
  impl: EVALUATE_IMPL,
  params: { seed: 1, resamples: 100, threshold: OP, weight: { feature: "log_text_len", log1p_scale: 10 }, ...params },
  inputs: { model: { external: "model" }, dataset: { external: "dataset" } },
});

const run = (w: World, params: Record<string, unknown>, extra: Partial<PipelineSpec["externals"]> = {}) =>
  runPipeline(specWith(plain(params), { ...w.externals, ...extra } as NonNullable<PipelineSpec["externals"]>), { dataDir: w.dataDir });

const reportOf = (w: World, r: Awaited<ReturnType<typeof run>>): EvalReport => w.store.handle((r.stages[0]?.outputs as Record<string, Sha256>)["report"] as Sha256, "EvalReport").json() as EvalReport;

describe("the test is opened once per (model, dataset)", () => {
  it("registers the first opening, refuses the second, and accepts a declared reopening (registered with its reason)", async () => {
    const w = world(false, { rowWeight: true });
    const first = await run(w, { split: "test" });
    expect(first.ok, JSON.stringify(first.stages[0]?.error)).toBe(true);
    const opened = readOpenings(w.dataDir);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ event: "open", split: "test", stage_id: "eval" });
    expect(opened[0]?.model_id).toMatch(/^sha256:/);
    expect(opened[0]?.reopened).toBeUndefined();
    expect(readFileSync(openingsPath(w.dataDir), "utf8").trim().split("\n")).toHaveLength(1);
    expect(reportOf(w, first).notes?.some((n) => /opened for this \(model, dataset\).*registered in test-openings\.jsonl/.test(n.text))).toBe(true);

    // another seed = another execution of the stage over the same pair: a second look
    const second = await run(w, { split: "test", seed: 2 });
    expect(second.ok).toBe(false);
    expect(second.stages[0]?.error).toMatch(/already opened for model sha256:.*ONCE per frozen model/s);
    expect(readOpenings(w.dataDir)).toHaveLength(1); // a refused look is not registered as a look

    const declared = await run(w, { split: "test", seed: 2, reopen_reason: "declared deviation D-1: bootstrap seed typo" });
    expect(declared.ok, JSON.stringify(declared.stages[0]?.error)).toBe(true);
    const all = readOpenings(w.dataDir);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ reopened: true, reopen_reason: "declared deviation D-1: bootstrap seed typo" });
    expect(reportOf(w, declared).notes?.some((n) => n.kind === "threat" && /second look at the test.*D-1/.test(n.text))).toBe(true);
  });

  it("is a different pair for another dataset, and a cache hit is not an opening", async () => {
    const w = world(false, { rowWeight: true });
    expect((await run(w, { split: "test" })).ok).toBe(true);
    const again = await run(w, { split: "test" });
    expect(again.counts).toMatchObject({ ran: 0, cached: 1 });
    expect(readOpenings(w.dataDir)).toHaveLength(1);
    // the same model on another dataset (other rows): its own first opening
    const other = w.store.putFiles("Dataset", buildDataset(GROUPS, synthRows(GROUPS, 14, 6), { rowWeight: true }));
    const r = await run(w, { split: "test" }, { dataset: { type: "Dataset", id: other } });
    expect(r.ok, JSON.stringify(r.stages[0]?.error)).toBe(true);
    const all = readOpenings(w.dataDir);
    expect(all).toHaveLength(2);
    expect(all[0]?.model_id).toBe(all[1]?.model_id);
    expect(all[0]?.dataset_id).not.toBe(all[1]?.dataset_id);
  });

  it("a --force re-run with the same declared reason reproduces the same report (notes do not depend on the history)", async () => {
    const w = world(false, { rowWeight: true });
    const params = { split: "test", reopen_reason: "forced re-run of a deterministic stage" };
    const first = await run(w, params);
    const forced = await runPipeline(specWith(plain(params), w.externals), { dataDir: w.dataDir, force: true });
    expect(forced.counts.ran).toBe(1);
    expect(forced.stages[0]?.outputs).toEqual(first.stages[0]?.outputs);
    expect(readOpenings(w.dataDir).map((o) => o.reopened)).toEqual([undefined, true]);
  });

  it("`all` opens the test too; train, val and dev do not, and dev reads train + val only", async () => {
    const w = world(false, { rowWeight: true });
    for (const split of ["train", "val", "dev"]) {
      const r = await run(w, { split });
      expect(r.ok, `${split}: ${JSON.stringify(r.stages[0]?.error)}`).toBe(true);
    }
    expect(readOpenings(w.dataDir)).toHaveLength(0);

    const dev = reportOf(w, await run(w, { split: "dev" }));
    const devGroups = GROUPS.filter((g) => g.split !== "test").map((g) => g.id).sort();
    expect(dev.intrinsic?.per_group.map((g) => g.group_id).sort()).toEqual(devGroups);
    expect(dev.split).toBe("all");
    expect(dev.notes?.some((n) => /dev" = train \+ val; the test split was NOT read/.test(n.text))).toBe(true);
    expect(dev.notes?.some((n) => n.kind === "threat" && /in-sample/.test(n.text))).toBe(true);
    const devRows = ROWS.filter((r) => devGroups.includes(r.g));
    expect(devRows.length).toBeGreaterThan(0);

    const all = await run(w, { split: "all" });
    expect(all.ok).toBe(true);
    expect(readOpenings(w.dataDir).map((o) => o.split)).toEqual(["all"]);
    expect((await run(w, { split: "all", seed: 9 })).stages[0]?.error).toMatch(/already opened/);
  });
});

describe("registerOpening", () => {
  it("is append-only JSONL next to the ledger, and the error names the first opening", () => {
    const w = world(false);
    const req = { dataDir: w.dataDir, runId: "run-a", stageId: "s", modelId: `sha256:${"a".repeat(64)}` as Sha256, datasetId: `sha256:${"b".repeat(64)}` as Sha256, split: "test" as const, now: () => new Date("2026-01-01T00:00:00Z") };
    expect(registerOpening(req)).toEqual({ reopened: false });
    expect(OPENINGS_FILE).toBe("test-openings.jsonl");
    try {
      registerOpening({ ...req, runId: "run-b" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TestReopenedError);
      expect((e as TestReopenedError).previous).toMatchObject({ run_id: "run-a", ts: "2026-01-01T00:00:00.000Z" });
    }
    expect(registerOpening({ ...req, runId: "run-c", reopenReason: "why" })).toEqual({ reopened: true });
    expect(readOpenings(w.dataDir).map((o) => o.run_id)).toEqual(["run-a", "run-c"]);
  });
});
