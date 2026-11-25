import { compare, contractId, validate, type EvalReport, type NodeLabels, type PipelineSpec, type Sha256 } from "@gran-prix/contracts";
import { parseExtras, renderReport } from "@gran-prix/report";
import { afterAll, describe, expect, it } from "vitest";
import { StageRegistry, checkPipeline, runPipeline, type StagePlugin } from "../src/index.js";
import { ALL_STAGES } from "../src/stages/index.js";
import { EVALUATE_IMPL } from "../src/stages/evaluate/stage.js";
import { FIXTURE_REOPEN, GROUPS, OP, PARAMS, ROWS, defaultWeight, snapshotOf, specWith, stage, world, type World } from "./evaluate-fixtures.js";
import { cleanupTmp } from "./helpers.js";

afterAll(cleanupTmp);

const TEST_GROUPS = GROUPS.filter((g) => g.split === "test");
const TEST_IDS = new Set(TEST_GROUPS.map((g) => g.id));
const TEST_ROWS = ROWS.filter((r) => TEST_IDS.has(r.g));
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

type Out = Record<string, Sha256>;
async function run(w: World, spec: PipelineSpec, plugins?: StagePlugin[]) {
  const r = await runPipeline(spec, { dataDir: w.dataDir, ...(plugins ? { plugins } : {}) });
  expect(r.ok, JSON.stringify(r.stages[0]?.error)).toBe(true);
  const out = r.stages[0]?.outputs as Out;
  return { r, out, report: w.store.handle(out["report"] as Sha256, "EvalReport").json() as EvalReport };
}

/** Params that exercise aggregates, a pooled-strata gate and a CI-bound gate on top of the shared fixture params. */
const { weight: _feature, ...SHARED } = PARAMS; // no params.weight: the dataset's own w is what is weighed
const V11 = {
  ...SHARED,
  aggregates: [{ name: "hard", strata: ["forum", "shop"] }],
  gates: [
    { id: "f1_floor", name: "F1 floor", metric: "f1", comparator: ">=", threshold: 0.2 },
    { id: "hard_floor", name: "F1 on hard", metric: "f1", comparator: ">=", threshold: 0.99, stratum: "hard" },
    { id: "pooled", metric: "recall", comparator: ">", threshold: 0, stratum: ["docs", "shop"], aggregation: "micro" },
    { id: "gain_vs_heur", name: "Gain over the heuristic", metric: "f1", comparator: ">=", threshold: -1, baseline: "heur", use_ci_lower: true },
    { id: "cap_fp", metric: "precision", comparator: "<=", threshold: 1, use_ci_lower: true, aggregation: "macro_page" },
  ],
};

describe("evaluate emits EvalReport 1.1.0 natively", () => {
  it("declares 1.1.0, validates, and every v1.1 field it fills is consistent", async () => {
    const w = world(true, { rowWeight: true });
    const { report, out } = await run(w, specWith(stage(V11), w.externals));
    const v = validate("eval-report", report);
    expect(v.issues).toEqual([]);
    expect(report.format_version).toBe("1.1.0");
    const i = report.intrinsic!;

    // identification and method
    expect(report.system).toEqual({ kind: "model", name: "dom-fixture-model" });
    expect(report.names).toEqual({ model: "dom-fixture-model" });
    expect(report.notes?.map((n) => n.kind)).toContain("note");
    expect(i.weighting).toMatchObject({ unit: "chars", positive_class: "keep (main + support)" });
    expect(i.weighting?.weight_source).toMatch(/dataset-row\.w/);
    expect(i.bootstrap).toEqual({ resamples: 200, seed: 20261125, cluster_by: "group_key", method: "percentile", stratified: true });

    // CIs: ordered, and over "overall" + every stratum, for the model and the baseline
    const scopes = ["docs", "forum", "overall", "shop"];
    expect(Object.keys(i.metric_ci?.model ?? {}).sort()).toEqual(scopes);
    expect(Object.keys(i.metric_ci?.baselines?.["heur"] ?? {}).sort()).toEqual(scopes);
    for (const table of [i.metric_ci?.model, ...Object.values(i.metric_ci?.baselines ?? {})]) {
      for (const cis of Object.values(table ?? {})) {
        for (const ci of Object.values(cis)) expect(ci![0]).toBeLessThanOrEqual(ci![1]);
        expect(Object.keys(cis).sort()).toEqual(["f1", "precision", "recall"]);
      }
    }

    // PR curve: sorted ascending, contains the operating point, which is the report threshold
    const pc = i.pr_curve!;
    expect(pc.points.length).toBeGreaterThanOrEqual(2);
    expect(pc.points.map((p) => p.threshold)).toEqual([...pc.points.map((p) => p.threshold)].sort((a, b) => a - b));
    expect(pc.operating_threshold).toBe(OP);
    expect(report.threshold).toBe(OP);
    expect(pc.points.some((p) => p.threshold === OP)).toBe(true);
    expect(pc.operating_rule).toMatch(/params\.threshold/);

    // aggregates: the declared one and the one pooled by a gate, with micro counts that add up
    expect(i.aggregates?.map((a) => a.name).sort()).toEqual(["docs+shop", "hard"]);
    const hard = i.aggregates!.find((a) => a.name === "hard")!;
    expect(hard.strata).toEqual(["forum", "shop"]);
    expect(hard.micro?.n).toBe(i.by_stratum["forum"]!.n + i.by_stratum["shop"]!.n);
    expect(hard.macro_page_f1).toBeGreaterThanOrEqual(0);
    expect(hard.macro_stratum_f1).toBeCloseTo((i.by_stratum["forum"]!.f1 + i.by_stratum["shop"]!.f1) / 2, 12);
    if (hard.ci95) expect(hard.ci95[0]).toBeLessThanOrEqual(hard.ci95[1]);

    // baselines and comparison
    expect(i.baselines["heur"]!.coverage).toBe(1);
    const strataOfComparison = i.comparison.map((c) => c.stratum);
    expect(strataOfComparison).toEqual(expect.arrayContaining(["overall", "docs", "forum", "shop", "hard", "docs+shop"]));
    for (const c of i.comparison) {
      expect(c.aggregation).toBe("macro_page");
      expect(c.ci95[0]).toBeLessThanOrEqual(c.ci95[1]);
      expect(c.delta).toBeCloseTo(c.model - c.baseline_value, 12);
    }

    // per group: key, characters, the baseline's F1
    expect(i.per_group).toHaveLength(8);
    for (const g of i.per_group) {
      const rows = TEST_ROWS.filter((r) => r.g === g.group_id);
      expect(g.group_key).toBe(GROUPS.find((x) => x.id === g.group_id)!.key);
      expect(g.n_chars).toBe(sum(rows.map(defaultWeight)));
      expect(Object.keys(g.f1_by_baseline ?? {})).toEqual(["heur"]);
    }

    // gates: structured, and `passed` is what comparator / threshold / value say
    expect(report.gates?.map((g) => g.id)).toEqual(["f1_floor", "hard_floor", "pooled", "gain_vs_heur", "cap_fp"]);
    for (const g of report.gates!) {
      expect(g.comparator && g.threshold !== undefined && g.unit && g.metric && g.aggregation && g.observed !== undefined).toBeTruthy();
      expect(g.passed).toBe(compare(g.value, g.comparator!, g.threshold!));
      if (g.use_ci_lower) {
        expect(g.ci95).toBeDefined();
        expect(g.value).toBe(g.comparator === ">=" || g.comparator === ">" ? g.ci95![0] : g.ci95![1]);
      } else {
        expect(g.value).toBe(g.observed);
      }
    }
    const byId = (id: string) => report.gates!.find((g) => g.id === id)!;
    expect(byId("hard_floor")).toMatchObject({ stratum: "hard", passed: false, name: "F1 on hard" });
    expect(byId("pooled")).toMatchObject({ stratum: "docs+shop", aggregation: "micro" });
    expect(byId("gain_vs_heur")).toMatchObject({ baseline: "heur", use_ci_lower: true, metric: "f1" });
    expect(byId("f1_floor").stratum).toBeUndefined();

    // the sidecar is still written, redundant with the report
    const extras = parseExtras(w.store.handle(out["extras"] as Sha256, "Bundle").json());
    expect(extras.metric_ci).toEqual(i.metric_ci);
    expect(extras.pr_curve?.points).toEqual(pc.points);
    expect(extras.gate_details?.["gain_vs_heur"]?.ci95).toEqual(byId("gain_vs_heur").ci95);
    expect(extras.notes).toEqual(report.notes);

    // the report package renders the 1.1 report with and without the sidecar
    // (the build in this tree still takes the display names from the sidecar: reading them from the report is the renderer's lane)
    expect(renderReport(report)).toContain("<!doctype html>");
    expect(renderReport(report, { extras })).toContain("dom-fixture-model");
  });

  it("is a pure function of the inputs: same report id across data dirs, and a changed gate changes it", async () => {
    const a = world(true, { rowWeight: true });
    const b = world(true, { rowWeight: true });
    const [ra, rb] = [await run(a, specWith(stage(V11), a.externals)), await run(b, specWith(stage(V11), b.externals))];
    expect(rb.report.report_id).toBe(ra.report.report_id);
    expect(rb.out).toEqual(ra.out);
    const other = await run(a, specWith(stage({ ...V11, gates: V11.gates.slice(0, 1) }), a.externals));
    expect(other.report.report_id).not.toBe(ra.report.report_id);
  });

  it("rejects an aggregate that clashes with a stratum or names an unknown stratum", async () => {
    const w = world();
    for (const [aggregates, msg] of [
      [[{ name: "docs", strata: ["forum"] }], /clashes with a stratum/],
      [[{ name: "hard", strata: ["forum", "nope"] }], /unknown stratum "nope"/],
    ] as const) {
      const bad = await runPipeline(specWith(stage({ ...PARAMS, aggregates }), w.externals), { dataDir: w.dataDir });
      expect(bad.ok).toBe(false);
      expect(bad.stages[0]?.error).toMatch(msg);
    }
  });
});

describe("weights: dataset-row.w, or the log_own_len recovery with a note", () => {
  const noGates = { seed: 3, resamples: 100, threshold: OP };

  it("uses the exact w of a dataset with row_weight (no cap, no feature needed)", async () => {
    const w = world(false, { rowWeight: true });
    const { report } = await run(w, specWith(stage(noGates, false), w.externals));
    expect(report.intrinsic?.overall.n).toBe(sum(TEST_ROWS.map(defaultWeight)));
    expect(report.intrinsic?.weighting).toMatchObject({ unit: "chars" });
    expect(report.notes?.some((n) => /characters of own text.*exact, from dataset-row\.w/.test(n.text))).toBe(true);
    expect(report.notes?.some((n) => /recovered/.test(n.text))).toBe(false);
  });

  it("params.weight overrides w: a feature recovery, or unit weights", async () => {
    const w = world(false, { rowWeight: true });
    const feature = await run(w, specWith(stage({ ...noGates, weight: PARAMS.weight }, false), w.externals));
    expect(feature.report.intrinsic?.overall.n).not.toBe(sum(TEST_ROWS.map(defaultWeight)));
    expect(feature.report.intrinsic?.weighting?.weight_source).toMatch(/^feature log_text_len/);
    expect(feature.report.notes?.some((n) => /recovered as round\(expm1\(log_text_len/.test(n.text))).toBe(true);
    const unit = await run(w, specWith(stage({ ...noGates, weight: "none" }, false), w.externals));
    expect(unit.report.intrinsic?.overall.n).toBe(TEST_ROWS.length);
    expect(unit.report.intrinsic?.weighting?.unit).toBe("elements");
    expect(unit.report.intrinsic?.per_group.every((g) => g.n_chars === undefined)).toBe(true);
  });

  it("falls back, with a note, on a dataset without row_weight", async () => {
    const w = world(false);
    const feature = await run(w, specWith(stage({ ...noGates, weight: PARAMS.weight }, false), w.externals));
    expect(feature.report.intrinsic?.weighting).toMatchObject({ unit: "chars" });
    expect(feature.report.notes?.some((n) => /recovered as round\(expm1\(log_text_len/.test(n.text))).toBe(true);
    expect(feature.report.notes?.some((n) => /rebuild the dataset/i.test(n.text))).toBe(true);
    // the default fallback looks for log_own_len, which the fixture model does not have: elements, said loudly
    const unit = await run(w, specWith(stage(noGates, false), w.externals));
    expect(unit.report.intrinsic?.overall.n).toBe(TEST_ROWS.length);
    expect(unit.report.intrinsic?.weighting?.unit).toBe("elements");
    expect(unit.report.notes?.some((n) => /ELEMENTS, not characters/.test(n.text))).toBe(true);
    // "row" needs the weight
    const bad = await runPipeline(specWith(stage({ ...noGates, weight: "row" }, false), w.externals), { dataDir: w.dataDir });
    expect(bad.stages[0]?.error).toMatch(/needs a dataset whose manifest declares row_weight/);
  });
});

/** One NodeLabels document (3 classes) for a snapshot. */
function labelsDoc(snapshot: Sha256, items: ReadonlyArray<readonly [number, number]>, kind: "readability" | "heuristic" = "readability"): NodeLabels {
  const body = {
    format: "gran-prix.node-labels" as const,
    format_version: "1.0.0" as const,
    snapshot_id: snapshot,
    label_space: { kind: "multiclass" as const, classes: ["main", "support", "noise"] as string[] },
    labeler: { id: `${kind}@2.0.0`, kind, version: "2.0.0", params_sha256: `sha256:${"1".repeat(64)}` as Sha256 },
    items: items.map(([unit_id, y]) => ({ unit_id, y, confidence: 0.8, source: kind })),
    coverage: { n_labeled: items.length, n_candidates: 14 },
  };
  return { ...body, labels_id: contractId("node-labels", body as unknown as Record<string, unknown>) } as NodeLabels;
}

/** Labels for the first six test pages, units 0..9 only (partial on both axes), plus a page the dataset does not have. */
const COVERED_GROUPS = TEST_GROUPS.slice(0, 6);
const COVERED_UNITS = 10;
const classOf = (r: (typeof ROWS)[number]): number => {
  const keep = r.u % 3 === 0 ? r.y === 0 : r.y === 1; // an imperfect labeler: wrong on every third unit
  return keep ? (r.u % 2 === 0 ? 0 : 1) : 2; // main | support | noise
};

function labelFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const g of COVERED_GROUPS) {
    const rows = ROWS.filter((r) => r.g === g.id && r.u < COVERED_UNITS);
    files[`labels/${g.id}.json`] = JSON.stringify(labelsDoc(g.snapshot!, rows.map((r) => [r.u, classOf(r)] as const)));
  }
  files["labels/elsewhere.json"] = JSON.stringify(labelsDoc(snapshotOf(99), [[0, 0]]));
  files["manifest.json"] = JSON.stringify({ note: "a sibling file of the set, not a NodeLabels document" });
  return files;
}

describe("NodeLabels as a baseline", () => {
  const labelStage = (params: Record<string, unknown>, port: "label_baselines" | "baselines" = "label_baselines"): PipelineSpec["stages"][number] => ({
    id: "eval",
    kind: "evaluate",
    impl: EVALUATE_IMPL,
    params: { reopen_reason: FIXTURE_REOPEN, ...params },
    inputs: { model: { external: "model" }, dataset: { external: "dataset" }, [port]: [{ external: "lab" }] },
  });
  const labelWorld = (type: "NodeLabelsSet" | "Bundle" = "NodeLabelsSet"): World => {
    const w = world(false, { rowWeight: true });
    w.externals["lab"] = { type, id: w.store.putFiles(type, labelFiles()) };
    return w;
  };
  const base = { seed: 7, resamples: 100, threshold: OP };

  /** Independent recomputation of the baseline's weighted counts from the rows and the labeler's rule. */
  function expected(keepOf: (r: (typeof ROWS)[number]) => boolean) {
    const covered = TEST_ROWS.filter((r) => COVERED_GROUPS.some((g) => g.id === r.g) && r.u < COVERED_UNITS);
    const c = { tp: 0, fp: 0, tn: 0, fn: 0 };
    for (const r of covered) c[r.y === 1 ? (keepOf(r) ? "tp" : "fn") : keepOf(r) ? "fp" : "tn"] += defaultWeight(r);
    return { ...c, n: sum(covered.map(defaultWeight)), units: covered.length, total: sum(TEST_ROWS.map(defaultWeight)) };
  }

  it("keeps main + support, leaves unlabeled units uncovered, and records the coverage", async () => {
    const w = labelWorld();
    const { report } = await run(w, specWith(labelStage(base), w.externals));
    expect(validate("eval-report", report).issues).toEqual([]);
    const want = expected((r) => classOf(r) !== 2);
    expect(want.units).toBeGreaterThan(0);
    expect(want.units).toBeLessThan(TEST_ROWS.length);
    const b = report.intrinsic!.baselines["readability"]!; // named after the labeler kind
    expect(b.overall).toMatchObject({ tp: want.tp, fp: want.fp, tn: want.tn, fn: want.fn, n: want.n });
    expect(b.coverage).toBeCloseTo(want.n / want.total, 12);
    expect(b.coverage).toBeGreaterThan(0);
    expect(b.coverage).toBeLessThan(1);
    // the model is compared with it on the covered units only, and the note says how much that is
    const overall = report.intrinsic!.comparison.find((c) => c.stratum === "overall" && c.baseline === "readability")!;
    expect(overall.n_groups).toBe(COVERED_GROUPS.length);
    expect(report.notes?.some((n) => /Baseline "readability" \(NodeLabels of readability@2\.0\.0, keep = main \+ support; 6 of 7 labeled pages are in the dataset\) covers \d+ of \d+ units/.test(n.text))).toBe(true);
    expect(report.intrinsic!.per_group.filter((g) => g.f1_by_baseline?.["readability"] !== undefined).map((g) => g.group_id).sort()).toEqual(COVERED_GROUPS.map((g) => g.id).sort());
  });

  it("keep_classes and names are params; a Bundle holding NodeLabels works on the `baselines` port too", async () => {
    const w = labelWorld();
    const main = await run(w, specWith(labelStage({ ...base, label_baseline: { keep_classes: ["main"], names: ["rb"] } }), w.externals));
    const want = expected((r) => classOf(r) === 0);
    expect(Object.keys(main.report.intrinsic!.baselines)).toEqual(["rb"]);
    expect(main.report.intrinsic!.baselines["rb"]!.overall).toMatchObject({ tp: want.tp, fp: want.fp, tn: want.tn, fn: want.fn });
    expect(main.report.notes?.some((n) => /keep = main,/.test(n.text) || /keep = main;/.test(n.text))).toBe(true);

    const wb = labelWorld("Bundle");
    const viaBundle = await run(wb, specWith(labelStage(base, "baselines"), wb.externals));
    const viaSet = await run(w, specWith(labelStage(base), w.externals));
    expect(viaBundle.report.intrinsic!.baselines).toEqual(viaSet.report.intrinsic!.baselines);
  });

  it("mixes with a prediction Bundle, applies a gate against it, and refuses clashing ids", async () => {
    const w = world(true, { rowWeight: true });
    w.externals["lab"] = { type: "NodeLabelsSet", id: w.store.putFiles("NodeLabelsSet", labelFiles()) };
    const spec = specWith(
      {
        ...stage({ ...base, gates: [{ id: "vs_rb", metric: "f1", comparator: ">=", threshold: -1, baseline: "readability", use_ci_lower: true }] }, true),
        inputs: { model: { external: "model" }, dataset: { external: "dataset" }, baselines: [{ external: "heur" }], label_baselines: [{ external: "lab" }] },
      },
      w.externals,
    );
    const { report } = await run(w, spec);
    expect(Object.keys(report.intrinsic!.baselines)).toEqual(["heur", "readability"]);
    expect(report.intrinsic!.baselines["heur"]!.coverage).toBe(1);
    expect(report.gates?.[0]).toMatchObject({ baseline: "readability", use_ci_lower: true });
    expect(validate("eval-report", report).issues).toEqual([]);

    const clash = await runPipeline(specWith({ ...stage({ ...base, label_baseline: { names: ["heur"] } }, true), inputs: { model: { external: "model" }, dataset: { external: "dataset" }, baselines: [{ external: "heur" }], label_baselines: [{ external: "lab" }] } }, w.externals), { dataDir: w.dataDir });
    expect(clash.stages[0]?.error).toMatch(/two baseline artifacts claim the id "heur"/);
  });

  it("the label_baselines port is type-checked: it takes a NodeLabelsSet, not a Bundle", () => {
    const reg = new StageRegistry(ALL_STAGES);
    expect(checkPipeline(specWith(labelStage(base), labelWorld().externals), reg).ok).toBe(true);
    const wrong = checkPipeline(specWith(labelStage(base), labelWorld("Bundle").externals), reg);
    expect(wrong.ok).toBe(false);
  });
});

describe("the mini pipeline with every new input stays a 100% cache hit on the second run", () => {
  it("run 1 executes, run 2 is cached with identical artifact ids", async () => {
    const w = world(true, { rowWeight: true });
    w.externals["lab"] = { type: "NodeLabelsSet", id: w.store.putFiles("NodeLabelsSet", labelFiles()) };
    let calls = 0;
    const plugins: StagePlugin[] = ALL_STAGES.map((p) => (p.spec.impl === EVALUATE_IMPL ? { spec: p.spec, run: (ctx) => (calls++, p.run(ctx)) } : p));
    const spec = specWith(
      { ...stage(V11, true), inputs: { model: { external: "model" }, dataset: { external: "dataset" }, baselines: [{ external: "heur" }], label_baselines: [{ external: "lab" }] } },
      w.externals,
    );
    const first = await runPipeline(spec, { dataDir: w.dataDir, plugins });
    expect(first.ok).toBe(true);
    expect(first.counts).toMatchObject({ ran: 1, cached: 0, failed: 0 });
    const second = await runPipeline(spec, { dataDir: w.dataDir, plugins });
    expect(second.counts).toMatchObject({ ran: 0, cached: 1, failed: 0 });
    expect(calls).toBe(1);
    expect(second.stages[0]?.outputs).toEqual(first.stages[0]?.outputs);
    console.log("RUN 1", JSON.stringify(first.counts), "RUN 2", JSON.stringify(second.counts));
  });
});
