// scripts/lib/decide-stats.mjs: the cluster bootstrap of the decision script runs on the pre-registered generator
// (numpy default_rng) and numpy's percentile. The expected numbers come from numpy itself, through the fixture of
// tools/baselines/stats/bootstrap_ref.py.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without declarations
import { clusterBootstrapQuantile, mean } from "../../../scripts/lib/decide-stats.mjs";

const fx = JSON.parse(readFileSync(fileURLToPath(new URL("../../../packages/stats/test/fixtures/bootstrap-parity.json", import.meta.url)), "utf8")) as { cases: any[] };
const byName = (n: string): any => fx.cases.find((c) => c.name === n);

describe("clusterBootstrapQuantile = numpy", () => {
  it("both ends of the 95% interval of 40 domains are numpy's, to the last bit (seed 20261125, B = 2000)", () => {
    const c = byName("flat-40-domains");
    const at = (q: number): number => clusterBootstrapQuantile(c.values, c.keys, { resamples: c.resamples, seed: c.seed, q });
    expect(at(0.025)).toBe(c.ci[0]);
    expect(at(0.975)).toBe(c.ci[1]);
    // the way decide-dom-v0 asks for it: (1 - level) / 2 is 0.025000000000000022 in floating point, numpy's 2.5 / 100 is 0.025
    expect(at((1 - 0.95) / 2)).toBe(c.ci[0]);
  });

  it("the 80% eligibility interval: (1 - 0.8) / 2 is 0.1 for numpy (another seed)", () => {
    const c = byName("flat-40-domains-80");
    expect(clusterBootstrapQuantile(c.values, c.keys, { resamples: c.resamples, seed: c.seed, q: (1 - 0.8) / 2 })).toBe(c.ci[0]);
  });

  it("is a function of the seed, not of the order the pages come in", () => {
    const c = byName("flat-40-domains");
    const ref = clusterBootstrapQuantile(c.values, c.keys, { resamples: 300, seed: 5, q: 0.05 });
    expect(clusterBootstrapQuantile(c.values, c.keys, { resamples: 300, seed: 5, q: 0.05 })).toBe(ref);
    expect(clusterBootstrapQuantile(c.values, c.keys, { resamples: 300, seed: 6, q: 0.05 })).not.toBe(ref);
    const idx = c.values.map((_: number, i: number) => i).reverse();
    const values = idx.map((i: number) => c.values[i]);
    const keys = idx.map((i: number) => c.keys[i]);
    // the sums per domain are the same set of numbers (accumulated in another order: equal up to rounding)
    expect(clusterBootstrapQuantile(values, keys, { resamples: 300, seed: 5, q: 0.05 })).toBeCloseTo(ref, 12);
  });

  it("refuses empty or mismatched inputs; one domain gives that domain's mean", () => {
    expect(() => clusterBootstrapQuantile([], [], { resamples: 5, seed: 1, q: 0.5 })).toThrow(/nothing to resample/);
    expect(() => clusterBootstrapQuantile([1], ["a", "b"], { resamples: 5, seed: 1, q: 0.5 })).toThrow(/same length/);
    expect(clusterBootstrapQuantile([1, 3], ["a", "a"], { resamples: 20, seed: 1, q: 0.05 })).toBe(2);
    expect(mean([1, 2, 3])).toBe(2);
  });
});
