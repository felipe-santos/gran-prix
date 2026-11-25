import type { ModelPackage } from "@gran-prix/contracts";
import { modelId } from "@gran-prix/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { CHECKS, loadModelPackage, wasmSha256, type Runtime } from "../src/index.js";
import { FIXTURE_DIR, cleanupTmp, readJson } from "./helpers.js";

afterAll(cleanupTmp);

describe("loadModelPackage on the contracts fixture", () => {
  for (const runtime of ["ts", "wasm"] as Runtime[]) {
    it(`passes all nine checks (runtime ${runtime})`, () => {
      const m = loadModelPackage(FIXTURE_DIR, { runtime });
      expect(m.checks.map((c) => c.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(m.checks.map((c) => c.id)).toEqual(CHECKS.map((c) => c.id));
      const manifest = readJson<ModelPackage>(FIXTURE_DIR, "model.json");
      expect(m.modelId).toBe(manifest.model_id);
      expect(m.modelId).toBe(modelId(manifest));
      expect(m.inputDim).toBe(4);
      expect(m.outputDim).toBe(1);
      expect(m.labels).toEqual(["drop", "keep"]);
      expect(m.warnings).toEqual([]);
      expect(m.weights.length).toBe(19);
      m.dispose();
    });

    it(`predicts golden.json from pre-normalization inputs (runtime ${runtime})`, () => {
      const m = loadModelPackage(FIXTURE_DIR, { runtime });
      const golden = readJson<{ cases: Array<{ input: number[]; score: number[] }> }>(FIXTURE_DIR, "golden.json");
      for (const c of golden.cases) {
        const p = m.predictProbs(c.input);
        expect(p.length).toBe(1);
        expect(Math.abs((p[0] as number) - (c.score[0] as number))).toBeLessThan(1e-5);
      }
      m.dispose();
    });

    it(`predictBatch equals row-wise predictProbs (runtime ${runtime})`, () => {
      const m = loadModelPackage(FIXTURE_DIR, { runtime });
      const golden = readJson<{ cases: Array<{ input: number[] }> }>(FIXTURE_DIR, "golden.json");
      const flat = golden.cases.flatMap((c) => c.input);
      const batch = m.predictBatch(flat, golden.cases.length);
      golden.cases.forEach((c, i) => expect(batch[i]).toBeCloseTo(m.predictProbs(c.input)[0] as number, 6));
      m.dispose();
    });
  }

  it("both runtimes agree on arbitrary inputs", () => {
    const a = loadModelPackage(FIXTURE_DIR, { runtime: "ts" });
    const b = loadModelPackage(FIXTURE_DIR, { runtime: "wasm" });
    for (let i = 0; i < 20; i++) {
      const x = [Math.sin(i), Math.cos(i * 2) * 0.5 + 0.5, (i % 2) as number, i / 40];
      expect(Math.abs((a.predictProbs(x)[0] as number) - (b.predictProbs(x)[0] as number))).toBeLessThan(1e-5);
    }
    a.dispose();
    b.dispose();
  });

  it("rejects inputs of the wrong length or non-finite", () => {
    const m = loadModelPackage(FIXTURE_DIR);
    expect(() => m.predictProbs([1, 2, 3])).toThrow(RangeError);
    expect(() => m.predictProbs([1, 2, Number.NaN, 4])).toThrow(/not finite/);
    m.dispose();
  });

  it("flags out-of-distribution features with the tolerance of feature_spec.ood", () => {
    const m = loadModelPackage(FIXTURE_DIR);
    expect(m.oodFeatures([0.5, 0.5, 0.5, 0.25])).toEqual([]);
    expect(m.oodFeatures([1.05, 0.5, 0.5, 0.25])).toEqual([]); // inside the 10% slack
    expect(m.oodFeatures([2, 0.5, -3, 0.25])).toEqual([0, 2]);
    m.dispose();
  });

  it("a disposed handle refuses to predict", () => {
    const m = loadModelPackage(FIXTURE_DIR);
    m.dispose();
    expect(() => m.predictProbs([0, 0, 0, 0])).toThrow(/disposed/);
  });
});

describe("wasm identity", () => {
  it("wasmSha256 is a sha256 id of the loaded binary", () => {
    expect(wasmSha256()).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
