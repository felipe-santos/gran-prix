import { readFileSync } from "node:fs";
import { validate, type EvalReport, type PipelineSpec, type Sha256 } from "@gran-prix/contracts";
import { loadModelPackage } from "@gran-prix/model";
import { parseExtras } from "@gran-prix/report";
import { afterAll, describe, expect, it } from "vitest";
import { StageRegistry, checkPipeline, runPipeline, type StagePlugin } from "../src/index.js";
import { ALL_STAGES } from "../src/stages/index.js";
import { EVALUATE_IMPL, planWeight, weightOf } from "../src/stages/evaluate/stage.js";
import { GROUPS, MODEL_DIR, OP, PARAMS, ROWS, WEIGHT, stage, world, specWith, type World } from "./evaluate-fixtures.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

/** Independent recomputation of the weighted confusion counts straight from the model package. */
function expectedCounts(split: "test" | "val" | "train", threshold: number) {
  const model = loadModelPackage(MODEL_DIR);
  const ids = new Set(GROUPS.filter((g) => g.split === split).map((g) => g.id));
  const rows = ROWS.filter((r) => ids.has(r.g));
  const probs = model.predictBatch(Float64Array.from(rows.flatMap((r) => r.x)), rows.length);
  const plan = planWeight(WEIGHT, model.manifest.feature_spec.names);
  const c = { tp: 0, fp: 0, tn: 0, fn: 0 };
  rows.forEach((r, i) => {
    const w = weightOf(plan, r.x);
    const pred = (probs[i] as number) >= threshold;
    if (r.y === 1) c[pred ? "tp" : "fn"] += w;
    else c[pred ? "fp" : "tn"] += w;
  });
  model.dispose();
  return { ...c, threshold: model.thresholds.accept, n: rows.length };
}

const sums = (a: Record<string, number>) => (a["tp"] as number) + (a["fp"] as number) + (a["tn"] as number) + (a["fn"] as number);

describe("ts:evaluate.intrinsic in a pipeline", () => {
  it("is registered, and its spec validates in a pipeline", () => {
    const reg = new StageRegistry(ALL_STAGES);
    const spec = reg.get(EVALUATE_IMPL)?.spec;
    expect(spec).toMatchObject({ kind: "evaluate", runtime: "node+wasm", determinism: "seeded" });
    // the canonical contract of the registry: model + dataset -> report (everything else is optional or extra)
    expect(spec?.inputs.filter((i) => i.optional !== true).map((i) => `${i.name}:${i.type}`)).toEqual(["model:ModelPackage", "dataset:Dataset"]);
    expect(spec?.outputs[0]).toMatchObject({ name: "report", type: "EvalReport" });
    const w = world();
    expect(checkPipeline(specWith(stage(PARAMS), w.externals), reg).ok).toBe(true);
    const noSeed = checkPipeline(specWith(stage({ split: "test" }), w.externals), reg);
    expect(noSeed.ok).toBe(false);
  });

  it("run 1 executes, run 2 is a 100% cache hit with identical artifact ids", async () => {
    const w = world();
    let calls = 0;
    const plugins: StagePlugin[] = ALL_STAGES.map((p) => (p.spec.impl === EVALUATE_IMPL ? { spec: p.spec, run: (ctx) => (calls++, p.run(ctx)) } : p));
    const spec = specWith(stage(PARAMS), w.externals);
    const logs: string[] = [];
    const first = await runPipeline(spec, { dataDir: w.dataDir, plugins, log: (s, m) => logs.push(`${s}: ${m}`) });
    expect(first.ok).toBe(true);
    expect(first.counts).toMatchObject({ ran: 1, cached: 0, failed: 0 });
    expect(calls).toBe(1);
    console.log("RUN 1", JSON.stringify(first.counts), first.stages[0]?.status, JSON.stringify(first.stages[0]?.outputs), logs.join(" | "));

    const second = await runPipeline(spec, { dataDir: w.dataDir, plugins });
    expect(second.counts).toMatchObject({ ran: 0, cached: 1, failed: 0 });
    expect(calls).toBe(1);
    expect(second.stages[0]?.outputs).toEqual(first.stages[0]?.outputs);
    console.log("RUN 2", JSON.stringify(second.counts), second.stages[0]?.status, JSON.stringify(second.stages[0]?.outputs));

    // --force re-executes and, the stage being deterministic, produces the very same artifacts
    const forced = await runPipeline(spec, { dataDir: w.dataDir, plugins, force: true });
    expect(forced.counts.ran).toBe(1);
    expect(calls).toBe(2);
    expect(forced.stages[0]?.outputs).toEqual(first.stages[0]?.outputs);
  });

  it("writes a contract-valid EvalReport whose counts equal an independent recomputation", async () => {
    const w = world();
    const run = await runPipeline(specWith(stage(PARAMS), w.externals), { dataDir: w.dataDir });
    const out = run.stages[0]?.outputs as Record<string, Sha256>;
    const report = w.store.handle(out["report"] as Sha256, "EvalReport").json() as EvalReport;
    expect(validate("eval-report", report).ok).toBe(true);
    expect(report).toMatchObject({ mode: "intrinsic", split: "test", threshold: OP });
    expect(report.dataset_id).toBe((JSON.parse(readFileSync(`${w.store.dirOf(w.externals["dataset"]?.id as Sha256)}/files/manifest.json`, "utf8")) as { dataset_id: string }).dataset_id);

    const want = expectedCounts("test", OP);
    expect(want.tp).toBeGreaterThan(0);
    expect(want.fp).toBeGreaterThan(0);
    expect(want.fn).toBeGreaterThan(0);
    const i = report.intrinsic;
    expect(i?.overall).toMatchObject({ tp: want.tp, fp: want.fp, tn: want.tn, fn: want.fn, n: sums(want) });
    expect(Object.keys(i?.by_stratum ?? {}).sort()).toEqual(["docs", "forum", "shop"]);
    expect(Object.values(i?.by_stratum ?? {}).reduce((a, s) => a + s.n, 0)).toBe(sums(want));
    expect(Object.values(i?.by_stratum ?? {}).reduce((a, s) => a + s.n_groups, 0)).toBe(8);
    expect(Object.keys(i?.baselines ?? {})).toEqual(["heur"]);
    expect(i?.per_group).toHaveLength(8);
    expect(i?.comparison.length).toBeGreaterThan(0);
    expect(report.gates?.map((g) => g.id)).toEqual(["f1_floor", "gain_vs_heur"]);
    expect(report.gates?.[1]?.rule).toContain("ci95_lower(");
  });

  it("the extras sidecar matches @gran-prix/report's schema and carries CIs, PR points, gate details and notes", async () => {
    const w = world();
    const run = await runPipeline(specWith(stage(PARAMS), w.externals), { dataDir: w.dataDir });
    const out = run.stages[0]?.outputs as Record<string, Sha256>;
    const extras = parseExtras(w.store.handle(out["extras"] as Sha256, "Bundle").json());
    expect(extras.names?.model).toBe("dom-fixture-model");
    expect(Object.keys(extras.metric_ci?.model ?? {}).sort()).toEqual(["docs", "forum", "overall", "shop"]);
    expect(Object.keys(extras.metric_ci?.baselines?.["heur"] ?? {}).sort()).toEqual(["docs", "forum", "overall", "shop"]);
    expect(extras.pr_curve?.points.length).toBeGreaterThanOrEqual(2);
    expect(extras.pr_curve?.points.some((p) => p.threshold === OP)).toBe(true);
    expect(extras.gate_details?.["gain_vs_heur"]).toMatchObject({ name: "Gain over the heuristic", threshold: ">= -1" });
    expect(extras.gate_details?.["gain_vs_heur"]?.ci95).toHaveLength(2);
    expect(extras.notes?.map((n) => n.kind)).toContain("note");
    expect(extras.notes?.some((n) => /characters of own text/.test(n.text))).toBe(true);
    const details = w.store.handle(out["details"] as Sha256, "Bundle").json() as { bootstrap: { resamples: number; seed: number } };
    expect(details.bootstrap).toMatchObject({ resamples: 200, seed: 20261125 });
  });

  it("same inputs and seed give the same report id; another seed changes the CIs but not the point estimates", async () => {
    const a = world();
    const b = world();
    const ra = await runPipeline(specWith(stage(PARAMS), a.externals), { dataDir: a.dataDir });
    const rb = await runPipeline(specWith(stage(PARAMS), b.externals), { dataDir: b.dataDir });
    const get = (w: World, r: typeof ra) => w.store.handle((r.stages[0]?.outputs as Record<string, Sha256>)["report"] as Sha256, "EvalReport").json() as EvalReport;
    const reportA = get(a, ra);
    const reportB = get(b, rb);
    expect(reportB.report_id).toBe(reportA.report_id);
    expect(ra.stages[0]?.outputs).toEqual(rb.stages[0]?.outputs); // even the artifact ids match across data dirs

    // 8 pages: draw pages (not domains) without stratification so the resampling has enough support to differ by seed
    const wide = { ...PARAMS, cluster_by: "group_id", stratified: false };
    const [r1, r2] = [await runPipeline(specWith(stage({ ...wide, seed: 1 }), a.externals), { dataDir: a.dataDir }), await runPipeline(specWith(stage({ ...wide, seed: 2 }), a.externals), { dataDir: a.dataDir })];
    const [c1, c2] = [get(a, r1), get(a, r2)];
    expect(c2.intrinsic?.overall).toEqual(c1.intrinsic?.overall);
    expect(c2.intrinsic?.comparison.map((c) => c.ci95)).not.toEqual(c1.intrinsic?.comparison.map((c) => c.ci95));
    expect(c2.report_id).not.toBe(c1.report_id);
  });

  it("works without baselines, on another split and with unit weights, noting the fallback", async () => {
    const w = world(false);
    const run = await runPipeline(specWith(stage({ seed: 3, split: "val", resamples: 100, threshold: 0.5 }, false), w.externals), { dataDir: w.dataDir });
    expect(run.ok).toBe(true);
    const out = run.stages[0]?.outputs as Record<string, Sha256>;
    const report = w.store.handle(out["report"] as Sha256, "EvalReport").json() as EvalReport;
    expect(report.split).toBe("val");
    expect(report.threshold).toBe(0.5);
    expect(report.intrinsic?.baselines).toEqual({});
    expect(report.gates).toBeUndefined();
    expect(report.intrinsic?.overall.n).toBe(28); // 2 groups x 14 rows, weight 1 each
    const extras = parseExtras(w.store.handle(out["extras"] as Sha256, "Bundle").json());
    expect(extras.notes?.some((n) => /ELEMENTS, not characters/.test(n.text))).toBe(true);
  });

  it("the wasm runtime gives the same counts as the ts runtime; label_sources filters rows", async () => {
    const w = world();
    const run = async (extra: Record<string, unknown>) => {
      const r = await runPipeline(specWith(stage({ ...PARAMS, resamples: 100, ...extra }), w.externals), { dataDir: w.dataDir });
      return w.store.handle((r.stages[0]?.outputs as Record<string, Sha256>)["report"] as Sha256, "EvalReport").json() as EvalReport;
    };
    const ts = await run({});
    const wasm = await run({ runtime: "wasm" });
    expect(wasm.intrinsic?.overall).toMatchObject({ tp: ts.intrinsic?.overall.tp, fp: ts.intrinsic?.overall.fp, tn: ts.intrinsic?.overall.tn, fn: ts.intrinsic?.overall.fn });
    const human = await run({ label_sources: ["human"] });
    expect(Object.keys(human.intrinsic?.by_label_source ?? {})).toEqual(["human"]);
    expect(human.intrinsic?.overall.n).toBeLessThan(ts.intrinsic?.overall.n ?? 0);
  });

  it('threshold "accept" (the default) is the package threshold', async () => {
    const w = world(false);
    const run = await runPipeline(specWith(stage({ seed: 3, resamples: 100 }, false), w.externals), { dataDir: w.dataDir });
    const report = w.store.handle((run.stages[0]?.outputs as Record<string, Sha256>)["report"] as Sha256, "EvalReport").json() as EvalReport;
    expect(report.threshold).toBe(0.7);
    expect(report.intrinsic?.overall.tp).toBe(0); // nothing reaches 0.7 with this fixture model
  });

  it("fails loudly on a bad gate or an unknown baseline", async () => {
    const w = world();
    const bad = await runPipeline(specWith(stage({ ...PARAMS, gates: [{ id: "g", metric: "f1", comparator: ">=", threshold: 0, stratum: "nope" }] }), w.externals), { dataDir: w.dataDir });
    expect(bad.ok).toBe(false);
    expect(bad.stages[0]?.error).toMatch(/unknown stratum "nope"/);
    const ghost = await runPipeline(specWith(stage({ ...PARAMS, baselines: ["ghost"] }), w.externals), { dataDir: w.dataDir });
    expect(ghost.stages[0]?.error).toMatch(/lists "ghost"/);
  });
});
