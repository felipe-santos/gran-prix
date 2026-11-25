import { describe, expect, it } from "vitest";
import { drawMultiplicities, makeRng, percentileCi, quantileSorted } from "../src/stages/evaluate/bootstrap.js";
import { evaluateCore, unitKeyOf, type BaselineInput, type CoreOptions, type GroupInfo, type ScoredRow } from "../src/stages/evaluate/core.js";
import type { GateParam } from "../src/stages/evaluate/gates.js";

/** Deterministic synthetic corpus: `pages` pages, two per domain, strata hard/easy alternating by domain. */
function synth(opts: { pages?: number; modelAcc: number; baseAcc: number; seed?: number }): { groups: GroupInfo[]; rows: ScoredRow[]; baseline: BaselineInput } {
  const rng = makeRng(opts.seed ?? 1);
  const pages = opts.pages ?? 40;
  const groups: GroupInfo[] = [];
  const rows: ScoredRow[] = [];
  const keep = new Map<string, boolean>();
  for (let g = 0; g < pages; g++) {
    const domain = Math.floor(g / 2);
    groups.push({ id: `p${String(g).padStart(3, "0")}`, key: `site${domain}.example`, stratum: domain % 2 === 0 ? "hard" : "easy" });
    // Domains differ in difficulty, so pages of one domain are correlated (the reason to cluster).
    const hardness = ((domain * 7) % 5) / 40;
    for (let u = 0; u < 14; u++) {
      const y = rng() < 0.5 ? 1 : 0;
      const modelRight = rng() < opts.modelAcc - hardness;
      const baseRight = rng() < opts.baseAcc - hardness;
      const predModel = modelRight ? y : 1 - y;
      rows.push({ g, u, y: y as 0 | 1, s: "human", w: 1 + Math.floor(rng() * 200), score: predModel === 1 ? 0.55 + rng() * 0.4 : 0.05 + rng() * 0.4 });
      keep.set(unitKeyOf(`p${String(g).padStart(3, "0")}`, u), baseRight ? y === 1 : y !== 1);
    }
  }
  return { groups, rows, baseline: { id: "base", keep } };
}

const OPTS: CoreOptions = { threshold: 0.5, seed: 11, resamples: 400, clusterBy: "group_key", stratified: true, aggregation: "macro_page", gates: [], prGrid: 11 };

describe("seeded RNG and resampling", () => {
  it("the same seed gives the same stream; another seed does not", () => {
    const a = makeRng(5);
    const b = makeRng(5);
    const c = makeRng(6);
    const sa = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(sa);
    expect(Array.from({ length: 5 }, c)).not.toEqual(sa);
    for (const v of sa) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of sa) expect(v).toBeLessThan(1);
  });

  it("clusters are redrawn whole: pages of one domain always have the same multiplicity", () => {
    const clusters = Array.from({ length: 6 }, (_, k) => ({ stratum: k % 2 ? "x" : "y", groups: [2 * k, 2 * k + 1] }));
    const rng = makeRng(3);
    for (let r = 0; r < 50; r++) {
      const m = drawMultiplicities(clusters, 12, rng, true);
      for (let k = 0; k < 6; k++) expect(m[2 * k]).toBe(m[2 * k + 1]);
      // stratified: each stratum redraws exactly as many clusters as it has
      expect([0, 2, 4].reduce((a, k) => a + (m[2 * k + 1] as number), 0)).toBe(3);
    }
  });

  it("percentile interval uses linear interpolation and refuses mostly-undefined draws", () => {
    expect(quantileSorted([0, 10], 0.25)).toBe(2.5);
    expect(percentileCi([1, 2, 3, 4, 5], 5, 0.5)).toEqual([2, 4]);
    expect(percentileCi([NaN, NaN, NaN, 1], 4)).toBeNull();
  });
});

describe("cluster bootstrap CIs", () => {
  const { groups, rows, baseline } = synth({ modelAcc: 0.92, baseAcc: 0.7 });
  const run = (over: Partial<CoreOptions> = {}, b: BaselineInput[] = [baseline]) => evaluateCore({ groups, rows, baselines: b }, { ...OPTS, ...over });

  it("is deterministic for a given seed (same report content) and changes with the seed", () => {
    const a = run();
    const b = run();
    expect(JSON.stringify(b.intrinsic)).toBe(JSON.stringify(a.intrinsic));
    expect(JSON.stringify(b.extras)).toBe(JSON.stringify(a.extras));
    expect(JSON.stringify(b.details)).toBe(JSON.stringify(a.details));
    const c = run({ seed: 12 });
    expect(JSON.stringify(c.intrinsic.comparison)).not.toBe(JSON.stringify(a.intrinsic.comparison));
    // the point estimates do not depend on the seed
    expect(c.intrinsic.overall).toEqual(a.intrinsic.overall);
  });

  it("every interval is ordered and covers its point estimate", () => {
    const { extras, intrinsic } = run();
    const model = extras.metric_ci?.model ?? {};
    expect(Object.keys(model).sort()).toEqual(["easy", "hard", "overall"]);
    const point: Record<string, { precision: number; recall: number; f1: number }> = { overall: intrinsic.overall, ...intrinsic.by_stratum };
    for (const [scope, cis] of Object.entries(model)) {
      for (const m of ["precision", "recall", "f1"] as const) {
        const ci = cis[m];
        const p = point[scope]?.[m] ?? NaN;
        expect(ci).toBeDefined();
        expect((ci as [number, number])[0]).toBeLessThanOrEqual((ci as [number, number])[1]);
        expect((ci as [number, number])[0]).toBeLessThanOrEqual(p + 1e-9);
        expect((ci as [number, number])[1]).toBeGreaterThanOrEqual(p - 1e-9);
      }
    }
    for (const c of intrinsic.comparison) {
      expect(c.ci95[0]).toBeLessThanOrEqual(c.delta);
      expect(c.ci95[1]).toBeGreaterThanOrEqual(c.delta);
    }
  });

  it("paired difference model - baseline: positive and clearly above 0 when the model is better", () => {
    const { intrinsic } = run();
    for (const c of intrinsic.comparison) {
      expect(c.delta).toBeGreaterThan(0.1);
      expect(c.ci95[0]).toBeGreaterThan(0);
    }
    expect(intrinsic.comparison.map((c) => c.stratum).sort()).toEqual(["easy", "hard"]);
  });

  it("paired difference is negative with a CI below 0 when the baseline is better", () => {
    const worse = synth({ modelAcc: 0.7, baseAcc: 0.93 });
    const { intrinsic } = evaluateCore({ groups: worse.groups, rows: worse.rows, baselines: [worse.baseline] }, OPTS);
    for (const c of intrinsic.comparison) {
      expect(c.delta).toBeLessThan(-0.1);
      expect(c.ci95[1]).toBeLessThan(0);
    }
  });

  it("two identical systems: delta exactly 0 with a degenerate interval at 0", () => {
    const same = synth({ modelAcc: 0.85, baseAcc: 0.85 });
    // the baseline repeats the model's decisions
    const keep = new Map(same.rows.map((r) => [unitKeyOf((same.groups[r.g] as GroupInfo).id, r.u), r.score >= 0.5] as const));
    const { intrinsic } = evaluateCore({ groups: same.groups, rows: same.rows, baselines: [{ id: "clone", keep }] }, OPTS);
    for (const c of intrinsic.comparison) {
      expect(c.delta).toBe(0);
      expect(c.ci95).toEqual([0, 0]);
    }
  });

  it("a noisy, nearly tied pair has an interval that straddles 0", () => {
    const tie = synth({ modelAcc: 0.8, baseAcc: 0.8, seed: 9, pages: 20 });
    const { intrinsic } = evaluateCore({ groups: tie.groups, rows: tie.rows, baselines: [tie.baseline] }, OPTS);
    const overall = intrinsic.comparison.find((c) => c.stratum === "hard");
    expect(overall?.ci95[0]).toBeLessThan(0);
    expect(overall?.ci95[1]).toBeGreaterThan(0);
  });
});

describe("gates", () => {
  const { groups, rows, baseline } = synth({ modelAcc: 0.92, baseAcc: 0.7 });
  const run = (gates: GateParam[], over: Partial<CoreOptions> = {}) => evaluateCore({ groups, rows, baselines: [baseline] }, { ...OPTS, gates, ...over });

  it("evaluates metric, comparator and threshold generically; the threshold is data", () => {
    const loose: GateParam = { id: "f1_ok", metric: "f1", comparator: ">=", threshold: 0.5 };
    const tight: GateParam = { id: "f1_perfect", metric: "f1", comparator: ">=", threshold: 0.999 };
    const { gates, intrinsic } = run([loose, tight]);
    expect(gates.map((g) => [g.id, g.passed])).toEqual([["f1_ok", true], ["f1_perfect", false]]);
    expect(gates[0]?.rule).toBe("f1 [macro_page, overall] >= 0.5");
    // a micro gate reads the same number as the report's overall F1
    const micro = run([{ ...loose, id: "m", aggregation: "micro" }]).gates[0];
    expect(micro?.value).toBeCloseTo(intrinsic.overall.f1, 12);
    // flipping the threshold flips the verdict: nothing is hard-coded
    expect(run([{ ...tight, threshold: 0.2 }]).gates[0]?.passed).toBe(true);
  });

  it("all four comparators", () => {
    const at = (cmp: GateParam["comparator"], t: number) => run([{ id: "g", metric: "recall", comparator: cmp, threshold: t, aggregation: "micro" }]).gates[0]?.passed;
    const recall = run([]).intrinsic.overall.recall;
    expect([at(">", recall - 0.01), at(">=", recall + 0.01), at("<", recall + 0.01), at("<=", recall - 0.01)]).toEqual([true, false, true, false]);
  });

  it("stratum filter pools the listed strata; unknown strata are an error", () => {
    const { gates } = run([{ id: "hard", metric: "f1", comparator: ">=", threshold: 0, stratum: ["hard"], aggregation: "micro" }]);
    const hard = run([]).intrinsic.by_stratum["hard"]?.f1;
    expect(gates[0]?.value).toBeCloseTo(hard ?? NaN, 12);
    expect(gates[0]?.rule).toContain("hard");
    expect(() => run([{ id: "x", metric: "f1", comparator: ">=", threshold: 0, stratum: "nope" }])).toThrow(/gate "x".*unknown stratum "nope"/);
  });

  it("use_ci_lower judges the conservative bound, so a point estimate that clears can still fail", () => {
    const point = run([{ id: "p", metric: "f1", comparator: ">=", threshold: 0, baseline: "base" }]).gates[0];
    expect(point?.value).toBeGreaterThan(0.1);
    // threshold between the CI lower bound and the point estimate
    const probe = run([{ id: "ci", metric: "f1", comparator: ">=", threshold: -1, baseline: "base", use_ci_lower: true }]);
    const lower = probe.gates[0]?.value ?? NaN;
    expect(lower).toBeLessThan(point?.value ?? NaN);
    const t = (lower + (point?.value ?? 0)) / 2;
    expect(run([{ id: "pt", metric: "f1", comparator: ">=", threshold: t, baseline: "base" }]).gates[0]?.passed).toBe(true);
    const strict = run([{ id: "lo", metric: "f1", comparator: ">=", threshold: t, baseline: "base", use_ci_lower: true }]);
    expect(strict.gates[0]?.passed).toBe(false);
    expect(strict.gates[0]?.rule).toContain("ci95_lower(");
    // the sidecar carries the CI of the observed statistic, and the threshold in words
    expect(strict.extras.gate_details?.["lo"]?.ci95?.[0]).toBeCloseTo(lower, 12);
    expect(strict.extras.gate_details?.["lo"]?.threshold).toBe(`>= ${t}`);
  });

  it("upper CI bound for < and <=; unknown baseline is an error", () => {
    const g = run([{ id: "u", metric: "f1", comparator: "<=", threshold: 5, baseline: "base", use_ci_lower: true }]).gates[0];
    expect(g?.rule).toContain("ci95_upper(");
    expect(() => run([{ id: "b", metric: "f1", comparator: ">=", threshold: 0, baseline: "ghost" }])).toThrow(/unknown baseline "ghost"/);
  });
});
