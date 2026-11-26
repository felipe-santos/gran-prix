// QA tool, statistics: McNemar exact and the paired cluster bootstrap against hand values and the Python reference
// (tools/baselines/stats/bootstrap_ref.py, numpy). The constants below were produced by that reference.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clusterMeanCi, cohenKappa, groupKeyOf, mcnemarExact, pairedDelta } from "../src/stages/qa/stats.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAIN_PYLIBS = "/home/ubuntu/files/PRIX/gran-prix/tools/baselines/.pylibs";

describe("McNemar exact", () => {
  it("matches the binomial tail computed by hand (python math.comb)", () => {
    expect(mcnemarExact(1, 5)).toBeCloseTo(0.21875, 12); // 2 * (1 + 6) / 64
    expect(mcnemarExact(5, 1)).toBeCloseTo(0.21875, 12); // symmetric
    expect(mcnemarExact(0, 8)).toBeCloseTo(0.0078125, 12); // 2 / 256
    expect(mcnemarExact(2, 10)).toBeCloseTo(0.03857421875, 12); // 2 * 79 / 4096
    expect(mcnemarExact(7, 19)).toBeCloseTo(0.028959274291992188, 12);
  });
  it("is 1 with no discordant pair or a balanced one, and never above 1", () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(3, 3)).toBe(1);
    expect(mcnemarExact(4, 4)).toBe(1);
  });
  it("stays finite for large counts", () => {
    const p = mcnemarExact(40, 400);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1e-50);
    expect(Number.isFinite(mcnemarExact(1000, 1100))).toBe(true);
  });
});

describe("paired cluster bootstrap", () => {
  const diffs = [1, 0, 0, 1, -1, 0, 1, 1, 0, 0, -1, 1, 0, 1];
  const keys = ["a.com", "a.com", "b.com", "b.com", "b.com", "c.org", "c.org", "d.net", "d.net", "d.net", "e.io", "e.io", "f.dev", "f.dev"];

  it("the interval equals the one the numpy reference gives (B = 2000, seed 20261125)", () => {
    const r = clusterMeanCi(diffs, keys, { resamples: 2000, seed: 20261125 });
    expect(r.mean).toBeCloseTo(0.2857142857142857, 12);
    expect(r.ci95[0]).toBeCloseTo(0.125, 12);
    expect(r.ci95[1]).toBeCloseTo(0.46153846153846156, 12);
  });

  const pylibs = [join(ROOT, "tools/baselines/.pylibs"), MAIN_PYLIBS].find((p) => existsSync(p));
  const hasNumpy = pylibs !== undefined && spawnSync("python3", ["-c", "import numpy"], { env: { ...process.env, PYTHONPATH: pylibs } }).status === 0;
  it.skipIf(!hasNumpy)("and so does a fresh run of the Python reference, when numpy is installed", () => {
    const code = `import sys,json; sys.path.insert(0, ${JSON.stringify(join(ROOT, "tools/baselines/stats"))}); import bootstrap_ref as b; v=${JSON.stringify(diffs)}; k=${JSON.stringify(keys)}; print(json.dumps(b.quantile_ci(b.cluster_mean_draws(v,k,None,1000,20261125,False),1000,0.95)))`;
    const out = spawnSync("python3", ["-c", code], { env: { ...process.env, PYTHONPATH: pylibs as string }, encoding: "utf8" });
    expect(out.status, out.stderr).toBe(0);
    const ref = JSON.parse(out.stdout) as [number, number];
    const mine = clusterMeanCi(diffs, keys, { resamples: 1000, seed: 20261125 });
    expect(mine.ci95[0]).toBe(ref[0]);
    expect(mine.ci95[1]).toBe(ref[1]);
  });

  it("pairedDelta: mean of (a - b), the discordant counts and McNemar's p come from the same pairs", () => {
    const a = [1, 1, 1, 0, 1, 1, 0, 1] as const;
    const b = [1, 0, 0, 0, 1, 0, 0, 1] as const;
    const ks = ["x", "x", "y", "y", "z", "z", "w", "w"];
    const r = pairedDelta(a, b, ks, { resamples: 500, seed: 20261125 });
    expect(r.n).toBe(8);
    expect(r.mean_delta).toBeCloseTo(3 / 8, 12);
    expect([r.only_a, r.only_b]).toEqual([3, 0]);
    expect(r.p_value).toBeCloseTo(0.25, 12); // 2 * (1/8)
    expect(r.ci95[0]).toBeLessThanOrEqual(r.mean_delta);
    expect(r.ci95[1]).toBeGreaterThanOrEqual(r.mean_delta);
  });

  it("resamples domains whole: a delta that is the same inside every domain has an interval of width zero only when every domain agrees", () => {
    const same = pairedDelta([1, 1, 1, 1], [0, 0, 0, 0], ["p", "p", "q", "q"], { resamples: 300, seed: 1 });
    expect(same.ci95).toEqual([1, 1]);
    const split = pairedDelta([1, 1, 0, 0], [0, 0, 0, 0], ["p", "p", "q", "q"], { resamples: 300, seed: 1 });
    expect(split.ci95[0]).toBe(0); // a resample may draw only domain q
    expect(split.ci95[1]).toBe(1);
  });

  it("is deterministic and refuses mismatched vectors", () => {
    const x = clusterMeanCi(diffs, keys, { resamples: 300, seed: 5 });
    expect(clusterMeanCi(diffs, keys, { resamples: 300, seed: 5 })).toEqual(x);
    expect(() => pairedDelta([1], [1, 0], ["a"], { resamples: 10, seed: 1 })).toThrow(RangeError);
    expect(() => clusterMeanCi([], [], { resamples: 10, seed: 1 })).toThrow(RangeError);
  });
});

describe("helpers", () => {
  it("the domain of a group id is what precedes the last #", () => {
    expect(groupKeyOf("shop.example.com#0123456789ab")).toBe("shop.example.com");
    expect(groupKeyOf("plain")).toBe("plain");
  });
  it("kappa of two raters", () => {
    expect(cohenKappa([true, true, false, false], [true, true, false, false])).toBe(1);
    expect(cohenKappa([true, false, true, false], [true, true, false, false])).toBeCloseTo(0, 12);
    expect(cohenKappa([true, true], [true, true])).toBeNull(); // no variation: expected agreement is 1
  });
});
