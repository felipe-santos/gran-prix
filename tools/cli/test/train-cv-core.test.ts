// tau*, the selection criterion, grouped folds and the nested CV of ts:train.cv, with no trainer and no model: the
// fitter is a toy. tau* and the folds are also cross-checked against tools/baselines/gbdt/gbdt.py when numpy is there.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertValid } from "@gran-prix/contracts";
import { describe, expect, it } from "vitest";
import { Limiter, runCv, type DevRows, type FitTag, type Fitter } from "../src/stages/train-cv/cv.js";
import { groupedFolds, splitFold } from "../src/stages/train-cv/folds.js";
import { DOM_V0_GRID, GRIDS, MAX_CONFIGS, assertBudget, trainConfigOf, type GridPoint } from "../src/stages/train-cv/grid.js";
import { bestConfig, macroPageF1, tauStar, weightedRecall } from "../src/stages/train-cv/tau.js";
import { makeRng } from "../src/stages/evaluate/bootstrap.js";

describe("tau* (protocol 6.3)", () => {
  it("is the largest threshold whose character-weighted recall is >= 0.95", () => {
    // positives (weight): 0.9 (50), 0.8 (45), 0.7 (5); the cut that first reaches 95 of 100 is 0.8
    const p = [0.9, 0.8, 0.7, 0.6, 0.5, 0.1];
    const y = [1, 1, 1, 0, 0, 0];
    const w = [50, 45, 5, 100, 100, 100];
    expect(tauStar(p, y, w)).toBe(0.8);
    expect(weightedRecall(p, y, w, 0.8)).toBeCloseTo(0.95, 12);
    expect(weightedRecall(p, y, w, 0.8000001)).toBeLessThan(0.95);
    // a different target moves it
    expect(tauStar(p, y, w, 0.5)).toBe(0.9);
    expect(tauStar(p, y, w, 1)).toBe(0.7);
  });

  it("weighs characters, not elements", () => {
    const p = [0.9, 0.5];
    const y = [1, 1];
    expect(tauStar(p, y, [1, 1])).toBe(0.5); // 2 elements: 95% needs both
    expect(tauStar(p, y, [100, 1])).toBe(0.9); // 100 of 101 characters = 99%
  });

  it("cuts only at the end of a run of equal scores", () => {
    // 0.7 appears for a positive and for a negative: "p >= 0.7" takes both, so the cut is 0.7, never "half of 0.7"
    const p = [0.9, 0.7, 0.7, 0.2];
    const y = [1, 1, 0, 1];
    const w = [10, 10, 10, 10];
    expect(tauStar(p, y, w, 2 / 3)).toBe(0.7);
    expect(tauStar(p, y, w, 0.75)).toBe(0.2);
  });

  it("returns 0.5 when no positive carries weight, and the lowest score when everything must be kept", () => {
    expect(tauStar([0.2, 0.9], [0, 0], [5, 5])).toBe(0.5);
    expect(tauStar([0.2, 0.9], [1, 1], [0, 0])).toBe(0.5);
    expect(tauStar([0.2, 0.9], [1, 1], [5, 5], 1)).toBe(0.2);
    expect(tauStar([], [], [])).toBe(0.5);
  });

  it("macro-page F1: mean of the per-page F1, an empty output is 0, never 1", () => {
    const pages = ["a", "a", "b", "b", "c"];
    const y = [1, 0, 1, 1, 0];
    const w = [10, 10, 10, 10, 10];
    // page a: keeps unit 0 only -> tp 10, fp 0, fn 0: 1. page b: keeps one of two -> tp 10, fn 10: 2/3. page c: no positives, keeps nothing -> 0 (den 0)
    const p = [0.9, 0.1, 0.9, 0.1, 0.1];
    expect(macroPageF1(p, y, w, pages, 0.5)).toBeCloseTo((1 + 2 / 3 + 0) / 3, 12);
    expect(macroPageF1(p, y, w, pages, 0.95)).toBe(0);
    expect(macroPageF1([], [], [], [], 0.5)).toBe(0);
  });

  it("bestConfig breaks ties towards the earlier configuration", () => {
    expect(bestConfig([0.5, 0.7, 0.7, 0.6])).toBe(1);
    expect(bestConfig([0.7, 0.7 + 1e-14])).toBe(0);
    expect(() => bestConfig([])).toThrow();
  });
});

describe("grouped folds", () => {
  const keys = ["a", "a", "a", "b", "b", "c", "d", "d", "d", "d", "e", "f"];

  it("never cut a domain, are deterministic and balanced", () => {
    const f = groupedFolds(keys, 3);
    for (const k of new Set(keys)) expect(new Set(keys.flatMap((x, i) => (x === k ? [f[i]] : []))).size).toBe(1);
    expect([...groupedFolds(keys, 3)]).toEqual([...f]);
    const load = [0, 1, 2].map((i) => [...f].filter((v) => v === i).length);
    expect(Math.max(...load) - Math.min(...load)).toBeLessThanOrEqual(2);
    // the greedy rule by hand: d(4) -> 0, a(3) -> 1, b(2) -> 2, then the singles c (lightest: 2), e (tie 1 and 2: lowest id 1), f (2)
    expect([...f]).toEqual([1, 1, 1, 2, 2, 2, 0, 0, 0, 0, 1, 2]);
  });

  it("refuses fewer domains than folds, or a single fold", () => {
    expect(() => groupedFolds(["a", "b"], 3)).toThrow(/cannot fill/);
    expect(() => groupedFolds(["a", "b"], 1)).toThrow(RangeError);
  });

  it("splitFold partitions the rows", () => {
    const f = groupedFolds(keys, 3);
    const { fit, held } = splitFold(f, 1);
    expect(fit.length + held.length).toBe(keys.length);
    expect(held.every((i) => f[i] === 1)).toBe(true);
  });
});

describe("the grid (protocol 7: <= 12 configurations, fixed a priori)", () => {
  it("has 12 named, distinct points within the budget", () => {
    expect(DOM_V0_GRID).toHaveLength(12);
    expect(MAX_CONFIGS).toBe(12);
    expect(() => assertBudget(DOM_V0_GRID)).not.toThrow();
    expect(new Set(DOM_V0_GRID.map((g) => g.name)).size).toBe(12);
    expect(GRIDS["dom-v0-mlp-v1"]).toBe(DOM_V0_GRID);
    expect(() => assertBudget([...DOM_V0_GRID, { name: "extra", hidden: [4], lr: 0.1, pos_weight: null }])).toThrow(/exceed/);
    expect(() => assertBudget([])).toThrow(/empty/);
    const dup = DOM_V0_GRID[0] as GridPoint;
    expect(() => assertBudget([dup, dup])).toThrow(/called/);
  });

  it("builds a valid, id-stamped TrainConfig with a fixed threshold, no early stopping", () => {
    const c = trainConfigOf(DOM_V0_GRID[0] as GridPoint, 3, { min_confidence: 0.5, allowed_sources: ["human"] }, 0.31);
    expect(c).toMatchObject({ seed: 3, threshold: { strategy: "fixed", value: 0.31 }, runtime: { engine: "gp-train" }, data: { min_confidence: 0.5, allowed_sources: ["human"] } });
    expect(c).not.toHaveProperty("early_stopping");
    expect(c.train_config_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(trainConfigOf(DOM_V0_GRID[0] as GridPoint, 3, { min_confidence: 0.5, allowed_sources: ["human"] }, 0.31).train_config_id).toBe(c.train_config_id);
    expect(trainConfigOf(DOM_V0_GRID[1] as GridPoint, 3, { min_confidence: 0.5, allowed_sources: ["human"] }, 0.31).train_config_id).not.toBe(c.train_config_id);
    // no row weights in the dataset: the config is the 1.0.0 document it always was, without the field
    expect(c.format_version).toBe("1.0.0");
    expect(c).not.toHaveProperty("sample_weight");
    assertValid("train-config", c);
  });

  it('a weighted dataset trains every grid point with sample_weight "row" (TrainConfig 1.1.0), a new config id', () => {
    const policy = { min_confidence: 0.5, allowed_sources: ["human" as const] };
    for (const point of DOM_V0_GRID) {
      const plain = trainConfigOf(point, 3, policy, 0.31);
      const c = trainConfigOf(point, 3, policy, 0.31, 40, true);
      expect(c).toMatchObject({ format_version: "1.1.0", sample_weight: "row", runtime: { engine: "gp-train" } });
      assertValid("train-config", c);
      expect(c.train_config_id).not.toBe(plain.train_config_id);
      // nothing else moves: the grid point is the same recipe, only the loss weights differ
      const { format_version: _v, sample_weight: _w, train_config_id: _i, ...rest } = c;
      const { format_version: _v2, train_config_id: _i2, ...restPlain } = plain;
      expect(rest).toEqual(restPlain);
    }
  });
});

// ------------------------------------------------------------------------------------------------------ nested CV

/** 10 domains x 2 pages x 12 units; the label follows feature x0 with noise, so a "fit" can learn it. */
function toyDev(): DevRows & { x: Float64Array; pageOf: string[] } {
  const rng = makeRng(7);
  const g: string[] = [];
  const key: string[] = [];
  const y: number[] = [];
  const w: number[] = [];
  const x: number[] = [];
  for (let d = 0; d < 10; d++)
    for (let pg = 0; pg < 2; pg++)
      for (let u = 0; u < 12; u++) {
        const v = rng();
        g.push(`d${d}-p${pg}`);
        key.push(`dom${d}.example`);
        x.push(v);
        y.push(v + (rng() - 0.5) * 0.4 > 0.5 ? 1 : 0);
        w.push(5 + Math.floor(rng() * 50));
      }
  return { g, key, y, w, x: Float64Array.from(x), pageOf: g };
}

const POINTS: GridPoint[] = [
  { name: "good", hidden: [4], lr: 1, pos_weight: null },
  { name: "bad", hidden: [4], lr: 2, pos_weight: null },
  { name: "worst", hidden: [4], lr: 3, pos_weight: null },
];

/** A "model" whose quality is set by the config (lr 1 = the true signal, 2 = a noisy one, 3 = anti-signal). */
function toyFitter(dev: ReturnType<typeof toyDev>, log: Array<{ point: string; fit: number[]; predict: number[]; tag: FitTag }>): Fitter {
  return async (point, fit, predict, tag) => {
    log.push({ point: point.name, fit: [...fit], predict: [...predict], tag });
    await new Promise((r) => setTimeout(r, 1)); // let the limiter interleave
    return predict.map((i) => {
      const v = dev.x[i] as number;
      return point.lr === 1 ? v : point.lr === 2 ? (v * 7919) % 1 : 1 - v;
    });
  };
}

describe("runCv: nested, grouped, selection by macro-page F1 at tau*", () => {
  it("picks the configuration with the best OOF, and tau* gives a character-weighted recall >= 0.95 on the nested OOF", async () => {
    const dev = toyDev();
    const log: Array<{ point: string; fit: number[]; predict: number[]; tag: FitTag }> = [];
    const r = await runCv(dev, POINTS, toyFitter(dev, log), { folds: 5, innerFolds: 3, jobs: 4 });
    expect(r.selected).toBe(0);
    expect(r.scores[0]).toBeGreaterThan(r.scores[1] as number);
    expect(r.scores[1]).toBeGreaterThan(r.scores[2] as number);
    expect(r.outerPicks).toEqual([0, 0, 0, 0, 0]);
    expect(weightedRecall(r.oof, dev.y, dev.w, r.tau)).toBeGreaterThanOrEqual(0.95);
    expect(r.tau).toBe(tauStar(r.oof, dev.y, dev.w));
    expect(r.macroPageF1).toBeCloseTo(macroPageF1(r.oof, dev.y, dev.w, dev.g, r.tau), 12);
    // 12... here 3 configs: all-dev CV 3x5, nested 5 x (3x3 inner + 1 refit)
    expect(r.fits).toBe(3 * 5 + 5 * (3 * 3 + 1));
    expect(log).toHaveLength(r.fits);
  });

  it("never lets a domain straddle fit and predict, and never lets an outer-held fold into its own tuning", async () => {
    const dev = toyDev();
    const log: Array<{ point: string; fit: number[]; predict: number[]; tag: FitTag }> = [];
    await runCv(dev, POINTS, toyFitter(dev, log), { folds: 5, innerFolds: 3, jobs: 3 });
    const outer = groupedFolds(dev.key, 5);
    for (const c of log) {
      const fitKeys = new Set(c.fit.map((i) => dev.key[i]));
      for (const i of c.predict) expect(fitKeys.has(dev.key[i] as string), "domain in fit and predict").toBe(false);
      expect(new Set([...c.fit, ...c.predict]).size).toBe(c.fit.length + c.predict.length);
    }
    for (let f = 0; f < 5; f++) {
      const heldRows = new Set(Array.from(outer).flatMap((v, i) => (v === f ? [i] : [])));
      // the tuning inside outer fold f (every "inner" fit) never touches a row of fold f, neither to fit nor to predict
      const inner = log.filter((c) => c.tag.phase === "inner" && c.tag.outer === f);
      expect(inner).toHaveLength(3 * 3); // 3 configs x 3 inner folds
      for (const c of inner) for (const i of [...c.fit, ...c.predict]) expect(heldRows.has(i), `inner fit of fold ${f} touches its own held-out row`).toBe(false);
      // the refit that scores fold f is fit on every other fold and predicts exactly fold f
      const refit = log.filter((c) => c.tag.phase === "outer" && c.tag.outer === f);
      expect(refit).toHaveLength(1);
      expect(new Set((refit[0] as (typeof log)[number]).predict)).toEqual(heldRows);
      expect((refit[0] as (typeof log)[number]).fit.some((i) => heldRows.has(i))).toBe(false);
      expect((refit[0] as (typeof log)[number]).fit.length + heldRows.size).toBe(dev.y.length);
    }
    expect(log.filter((c) => c.tag.phase === "select")).toHaveLength(3 * 5);
  });

  it("the result does not depend on how many fits run at once", async () => {
    const dev = toyDev();
    const a = await runCv(dev, POINTS, toyFitter(dev, []), { folds: 5, innerFolds: 3, jobs: 1 });
    const b = await runCv(dev, POINTS, toyFitter(dev, []), { folds: 5, innerFolds: 3, jobs: 8 });
    expect(Array.from(b.oof)).toEqual(Array.from(a.oof));
    expect(b.tau).toBe(a.tau);
    expect(b.scores).toEqual(a.scores);
  });

  it("fails loudly with fewer domains than folds", async () => {
    const dev = toyDev();
    await expect(runCv(dev, POINTS, toyFitter(dev, []), { folds: 20, innerFolds: 3, jobs: 2 })).rejects.toThrow(/cannot fill/);
  });
});

describe("Limiter", () => {
  it("never runs more than `limit` tasks at once", async () => {
    const l = new Limiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        l.run(async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 3));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(() => new Limiter(0)).toThrow(RangeError);
  });
});

// --------------------------------------------------------------------------- cross-check against the Python (GBDT)

const GBDT_DIR = fileURLToPath(new URL("../../baselines/gbdt/", import.meta.url));
const PYLIBS = process.env["GP_BASELINES_PYLIBS"] ?? fileURLToPath(new URL("../../baselines/.pylibs", import.meta.url));
const hasNumpy = existsSync(join(PYLIBS, "numpy"));
if (!hasNumpy) console.warn("[train-cv] tau*/folds cross-check against gbdt.py SKIPPED: numpy is not in tools/baselines/.pylibs (or GP_BASELINES_PYLIBS)");

(hasNumpy ? describe : describe.skip)("same tau*, macro-page F1 and folds as tools/baselines/gbdt/gbdt.py", () => {
  it("agree on 40 random problems (ties, empty classes, zero weights included)", () => {
    const rng = makeRng(42);
    const cases = Array.from({ length: 40 }, (_, c) => {
      const n = 5 + Math.floor(rng() * 200);
      const levels = c % 3 === 0 ? 6 : 1e9; // every third case has heavy ties
      const p = Array.from({ length: n }, () => Math.round(rng() * levels) / levels);
      const y = Array.from({ length: n }, () => (rng() < (c % 7 === 0 ? 0.02 : 0.4) ? 1 : 0));
      const w = Array.from({ length: n }, () => (c % 5 === 0 && rng() < 0.2 ? 0 : 1 + Math.floor(rng() * 80)));
      const pages = Array.from({ length: n }, () => `pg${Math.floor(rng() * 6)}`);
      const keys = Array.from({ length: n }, () => `d${Math.floor(rng() * 9)}`);
      return { p, y, w, pages, keys, k: 2 + (c % 4) };
    });
    const script = `
import sys, json, importlib.util
sys.path.insert(0, sys.argv[2])
import numpy as np
spec = importlib.util.spec_from_file_location("gbdt", sys.argv[1] + "/gbdt.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
out = []
for c in json.load(sys.stdin):
    p, y, w = np.array(c["p"]), np.array(c["y"]), np.array(c["w"], dtype=float)
    t = m.tau_star(p, y, w)
    pages = np.array(c["pages"], dtype=object)
    keys = np.array(c["keys"], dtype=object)
    out.append({"tau": t, "f1": m.macro_page_f1(p, y, w, pages, t),
                "folds": m.grouped_folds(keys, w, c["k"]).tolist() if len(set(c["keys"])) >= c["k"] else None})
print(json.dumps(out))
`;
    const r = spawnSync("python3", ["-I", "-c", script, GBDT_DIR, PYLIBS], { input: JSON.stringify(cases), encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, maxBuffer: 64 * 1024 * 1024 });
    expect(r.status, r.stderr).toBe(0);
    const py = JSON.parse(r.stdout) as Array<{ tau: number; f1: number; folds: number[] | null }>;
    cases.forEach((c, i) => {
      const t = tauStar(c.p, c.y, c.w);
      expect(t, `case ${i} tau*`).toBe((py[i] as (typeof py)[number]).tau);
      expect(macroPageF1(c.p, c.y, c.w, c.pages, t), `case ${i} macro-page F1`).toBeCloseTo((py[i] as (typeof py)[number]).f1, 12);
      const folds = (py[i] as (typeof py)[number]).folds;
      if (folds !== null) expect([...groupedFolds(c.keys, c.k)], `case ${i} folds`).toEqual(folds);
    });
  });
});
