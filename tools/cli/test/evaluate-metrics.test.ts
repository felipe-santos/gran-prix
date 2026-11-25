import { describe, expect, it } from "vitest";
import { aucRoc, brier, calibration, logloss, metricOf, prAuc, prPoints, type Scored } from "../src/stages/evaluate/metrics.js";
import { evaluateCore, unitKeyOf, type BaselineInput, type CoreOptions, type GroupInfo, type ScoredRow } from "../src/stages/evaluate/core.js";

const OPTS: CoreOptions = {
  threshold: 0.5,
  seed: 7,
  resamples: 200,
  clusterBy: "group_id",
  stratified: true,
  aggregation: "macro_page",
  gates: [],
  prGrid: 11,
};

/**
 * Two pages, hand-counted at threshold 0.5.
 *   a (stratum s1): TP 100, FN 50, FP 30, TN 20   -> P 100/130, R 100/150, F1 200/280
 *   b (stratum s2): TP 10, FP 90                   -> P 0.1,     R 1,       F1 20/110
 * Weights are characters; with weight 1 every row counts once.
 */
const GROUPS: GroupInfo[] = [
  { id: "a", key: "d1", stratum: "s1" },
  { id: "b", key: "d2", stratum: "s2" },
];
const row = (g: number, u: number, y: 0 | 1, score: number, w: number, s = "human"): ScoredRow => ({ g, u, y, s, w, score });
const ROWS: ScoredRow[] = [
  row(0, 0, 1, 0.9, 100), // TP
  row(0, 1, 1, 0.2, 50), // FN
  row(0, 2, 0, 0.8, 30, "llm"), // FP
  row(0, 3, 0, 0.1, 20), // TN
  row(1, 0, 1, 0.7, 10), // TP
  row(1, 1, 0, 0.6, 90, "llm"), // FP
];

describe("element-level, character-weighted P/R/F1 (positive = keep)", () => {
  const { intrinsic: i, details } = evaluateCore({ groups: GROUPS, rows: ROWS, baselines: [] }, OPTS);

  it("per stratum: weighted confusion counts and the known P/R/F1", () => {
    const s1 = i.by_stratum["s1"];
    expect(s1).toMatchObject({ n: 200, tp: 100, fp: 30, tn: 20, fn: 50, n_groups: 1 });
    expect(s1?.precision).toBeCloseTo(100 / 130, 12);
    expect(s1?.recall).toBeCloseTo(100 / 150, 12);
    expect(s1?.f1).toBeCloseTo(200 / 280, 12);
    expect(s1?.accuracy).toBeCloseTo(120 / 200, 12);
    const s2 = i.by_stratum["s2"];
    expect(s2).toMatchObject({ n: 100, tp: 10, fp: 90, tn: 0, fn: 0 });
    expect(s2?.precision).toBeCloseTo(0.1, 12);
    expect(s2?.recall).toBe(1);
    expect(s2?.f1).toBeCloseTo(20 / 110, 12);
  });

  it("overall is the micro aggregate (counts summed over pages)", () => {
    expect(i.overall).toMatchObject({ n: 300, tp: 110, fp: 120, tn: 20, fn: 50 });
    expect(i.overall.f1).toBeCloseTo(220 / 390, 12);
  });

  it("macro-by-page is the mean of page F1 and differs from micro", () => {
    const macro = (details["aggregates"] as Record<string, Record<string, Record<string, Record<string, { value: number }>>>>)["overall"]?.["model"]?.["macro_page"]?.["f1"]?.value;
    expect(macro).toBeCloseTo((200 / 280 + 20 / 110) / 2, 12);
    expect(macro).not.toBeCloseTo(220 / 390, 3);
  });

  it("character weighting changes the numbers: weight 1 counts elements", () => {
    const unit = evaluateCore({ groups: GROUPS, rows: ROWS.map((r) => ({ ...r, w: 1 })), baselines: [] }, OPTS).intrinsic;
    expect(unit.by_stratum["s1"]).toMatchObject({ n: 4, tp: 1, fp: 1, tn: 1, fn: 1 });
    expect(unit.by_stratum["s1"]?.f1).toBeCloseTo(0.5, 12);
    expect(unit.by_stratum["s1"]?.f1).not.toBeCloseTo(i.by_stratum["s1"]?.f1 ?? 0, 3);
  });

  it("per_group F1 and kept_ratio, by_label_source and counts invariants", () => {
    const a = i.per_group.find((g) => g.group_id === "a");
    expect(a?.f1).toBeCloseTo(200 / 280, 12);
    expect(a?.kept_ratio).toBeCloseTo(130 / 200, 12);
    expect(i.by_label_source["human"]).toMatchObject({ n: 180, tp: 110, fn: 50, fp: 0, tn: 20 });
    expect(i.by_label_source["llm"]).toMatchObject({ n: 120, fp: 120 });
    for (const p of [i.overall, ...Object.values(i.by_stratum)]) expect(p.tp + p.fp + p.tn + p.fn).toBe(p.n);
  });

  it("empty output scores P = 0 and F1 = 0, never 1", () => {
    expect(metricOf({ tp: 0, fp: 0, tn: 5, fn: 0 }, "precision")).toBe(0);
    expect(metricOf({ tp: 0, fp: 0, tn: 5, fn: 0 }, "f1")).toBe(0);
    expect(metricOf({ tp: 0, fp: 0, tn: 5, fn: 3 }, "recall")).toBe(0);
    expect(metricOf({ tp: 0, fp: 0, tn: 0, fn: 0 }, "accuracy")).toBe(0);
  });

  it("zero-weight rows count for nothing, and a page with no weight is left out of the macro", () => {
    const extra = [...ROWS, row(0, 9, 1, 0.99, 0)];
    expect(evaluateCore({ groups: GROUPS, rows: extra, baselines: [] }, OPTS).intrinsic.overall.tp).toBe(110);
  });
});

describe("score metrics", () => {
  const s: Scored[] = [
    { score: 0.9, y: 1, w: 1 },
    { score: 0.8, y: 1, w: 1 },
    { score: 0.7, y: 0, w: 1 },
    { score: 0.3, y: 1, w: 1 },
    { score: 0.2, y: 0, w: 1 },
  ];
  it("AUC matches the pairwise definition; ties count half; one class gives 0.5", () => {
    expect(aucRoc(s)).toBeCloseTo(5 / 6, 12); // 5 of the 6 (pos, neg) pairs are ordered
    expect(aucRoc([{ score: 0.5, y: 1, w: 1 }, { score: 0.5, y: 0, w: 1 }])).toBe(0.5);
    expect(aucRoc([{ score: 0.5, y: 1, w: 1 }])).toBe(0.5);
  });
  it("weights act as repetition", () => {
    const doubled: Scored[] = s.flatMap((r) => [r, r]);
    const weighted = s.map((r) => ({ ...r, w: 2 }));
    expect(aucRoc(weighted)).toBeCloseTo(aucRoc(doubled), 12);
    expect(prAuc(weighted)).toBeCloseTo(prAuc(doubled), 12);
    expect(logloss(weighted)).toBeCloseTo(logloss(s), 12);
  });
  it("average precision, logloss, Brier and calibration on a known case", () => {
    // ranking: P P N P N -> AP = 1/3 * (1/1 + 2/2 + 3/4)
    expect(prAuc(s)).toBeCloseTo((1 + 1 + 0.75) / 3, 12);
    expect(brier(s)).toBeCloseTo((0.01 + 0.04 + 0.49 + 0.49 + 0.04) / 5, 12);
    expect(logloss(s)).toBeCloseTo(-(Math.log(0.9) + Math.log(0.8) + Math.log(0.3) + Math.log(0.3) + Math.log(0.8)) / 5, 12);
    const c = calibration(s, 2);
    expect(c.bins.map((b) => b.n)).toEqual([2, 3]);
    expect(c.ece).toBeCloseTo((2 / 5) * Math.abs(0.5 - 0.25) + (3 / 5) * Math.abs(2 / 3 - 0.8), 12);
  });
  it("PR points skip thresholds that keep nothing", () => {
    const pts = prPoints(s, [0, 0.5, 0.95]);
    expect(pts.map((p) => p.threshold)).toEqual([0, 0.5]);
    expect(pts[1]).toEqual({ threshold: 0.5, precision: 2 / 3, recall: 2 / 3 });
  });
});

describe("baselines", () => {
  const keepAll = (id: string, units: Array<[string, number]>): BaselineInput => ({ id, keep: new Map(units.map(([g, u]) => [unitKeyOf(g, u), true])) });

  it("covers only the units it lists; the model is compared on the same units", () => {
    // The baseline covers page a only, and says keep for all 4 of its units.
    const b = keepAll("always_keep", [["a", 0], ["a", 1], ["a", 2], ["a", 3]]);
    const { intrinsic: i, details } = evaluateCore({ groups: GROUPS, rows: ROWS, baselines: [b] }, OPTS);
    expect(i.baselines["always_keep"]?.overall).toMatchObject({ n: 200, tp: 150, fp: 50, tn: 0, fn: 0 });
    expect(i.baselines["always_keep"]?.by_stratum["s2"]).toMatchObject({ n: 0 });
    const all = i.comparison.filter((c) => c.baseline === "always_keep");
    expect(all.map((c) => c.stratum)).toEqual(["overall", "s1"]); // s2 has no covered unit
    expect(all[0]).toMatchObject({ n_groups: 1 }); // overall: only the pages the baseline covers
    const cmp = all.filter((c) => c.stratum !== "overall");
    expect(cmp[0]?.model).toBeCloseTo(200 / 280, 12);
    expect(cmp[0]?.baseline_value).toBeCloseTo(300 / 350, 12);
    expect(cmp[0]?.delta).toBeCloseTo(cmp[0] ? cmp[0].model - cmp[0].baseline_value : NaN, 12);
    expect((details["coverage"] as Record<string, { covered: number; units: number }>)["always_keep"]).toMatchObject({ covered: 4, units: 6 });
  });
});
