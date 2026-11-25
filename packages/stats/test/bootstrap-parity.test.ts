// The canonical bootstrap in TS against its Python reference (tools/baselines/stats/bootstrap_ref.py):
// same pools, same resampled indices, same replicate means and the same interval, to the last bit.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Generator, bootstrapPools, clusterMeanDraws, compareCodePoints, percentileCi } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
const FIXTURE = join(HERE, "fixtures/bootstrap-parity.json");
const fx = JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: any[] };

const sha = (v: Float64Array): string => createHash("sha256").update(Buffer.from(v.buffer, v.byteOffset, v.byteLength)).digest("hex");

describe("canonical bootstrap against bootstrap_ref.py", () => {
  for (const c of fx.cases) {
    describe(c.name, () => {
      const units = c.units.map(([stratum, key]: [string, string]) => ({ stratum, key }));

      it("pools: the strata and the clusters in the canonical order", () => {
        expect(bootstrapPools(units, c.stratified)).toEqual(c.pools);
      });

      it("the first replicates draw the same positions, pool by pool", () => {
        const pools = bootstrapPools(units, c.stratified);
        const rng = Generator.defaultRng(c.seed);
        const first = c.first_replicates.map(() => pools.map((p) => Array.from(rng.integers(0, p.length, p.length))));
        expect(first).toEqual(c.first_replicates);
      });

      it("replicate means and the percentile interval are bit-identical", () => {
        const draws = clusterMeanDraws({ values: c.values, keys: c.keys, ...(c.strata ? { strata: c.strata } : {}), resamples: c.resamples, seed: c.seed, stratified: c.stratified });
        expect(Array.from(draws.slice(0, 6))).toEqual(c.draws_head);
        expect(sha(draws)).toBe(c.draws_sha256);
        expect(percentileCi(Array.from(draws), c.resamples, c.level)).toEqual(c.ci);
      });
    });
  }

  it("regenerates from Python byte for byte when numpy is importable", () => {
    const pylibs = join(REPO, "tools/baselines/.pylibs");
    const script = join(REPO, "tools/baselines/stats/bootstrap_ref.py");
    const env = { ...process.env, PYTHONPATH: [pylibs, process.env.PYTHONPATH].filter(Boolean).join(":") };
    if (!existsSync(script) || spawnSync("python3", ["-c", "import numpy"], { env }).status !== 0) return; // no Python here: the committed fixture above is the check
    const r = spawnSync("python3", [script], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(readFileSync(FIXTURE, "utf8"));
  });
});

describe("canonical order and refusals", () => {
  it("strings compare by code point, not by UTF-16 unit", () => {
    expect(compareCodePoints("～", "\u{1f600}")).toBeLessThan(0); // 0xFF5E < 0x1F600, although the surrogate 0xD83D < 0xFF5E
    expect(["\u{1f600}", "～"].sort()).toEqual(["\u{1f600}", "～"]); // what the default sort does (wrong for us)
    expect(compareCodePoints("a", "ab")).toBeLessThan(0);
    expect(compareCodePoints("b", "a")).toBeGreaterThan(0);
    expect(compareCodePoints("x", "x")).toBe(0);
  });

  it("stratified pools are the strata in order; flat is one pool ordered by key then stratum", () => {
    const units = [
      { stratum: "b", key: "k2" },
      { stratum: "a", key: "k9" },
      { stratum: "b", key: "k1" },
      { stratum: "a", key: "k3" },
    ];
    expect(bootstrapPools(units, true)).toEqual([[3, 1], [2, 0]]);
    expect(bootstrapPools(units, false)).toEqual([[2, 0, 3, 1]]);
    expect(bootstrapPools([], true)).toEqual([]);
    expect(bootstrapPools([], false)).toEqual([]);
  });

  it("a repeated (stratum, key) is an error", () => {
    expect(() => bootstrapPools([{ stratum: "a", key: "k" }, { stratum: "a", key: "k" }], true)).toThrow(/duplicate/);
  });

  it("clusterMeanDraws refuses inputs of different lengths", () => {
    expect(() => clusterMeanDraws({ values: [1, 2], keys: ["a"], resamples: 1, seed: 1, stratified: false })).toThrow(RangeError);
  });

  it("percentile interval: linear interpolation, null when fewer than half of the replicates are finite", () => {
    expect(percentileCi([1, 2, 3, 4, 5], 5, 0.5)).toEqual([2, 4]);
    expect(percentileCi([NaN, NaN, NaN, 1], 4)).toBeNull();
    expect(percentileCi([], 0)).toBeNull();
    expect(percentileCi([NaN, 1, 2, 3], 4, 0.5)).toEqual([1.5, 2.5]);
  });
});
