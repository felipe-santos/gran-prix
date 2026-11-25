import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Of, type Golden, type ModelPackage } from "@gran-prix/contracts";
import { createPredictor } from "@gran-prix/infer-ts";
import { afterAll, describe, expect, it } from "vitest";
import { ModelPackageError, loadModelPackage, wasmEntryPath, type Runtime } from "../src/index.js";
import { FIXTURE_DIR, cleanupTmp, copyFixture, readJson, reseal } from "./helpers.js";

afterAll(cleanupTmp);

interface TrainerLike {
  get_weights(): Float32Array;
  networkDefJson(): string;
  paramShapes(): Array<{ name: string; shape: number[]; offset: number; len: number }>;
}
const wasm = createRequire(import.meta.url)(wasmEntryPath()) as {
  Trainer: { fromNetworkDefSeeded(json: string, seed: number): TrainerLike };
};

/** A 4 -> 6 -> 3 softmax package whose golden is computed independently of the loader's output code. */
function softmaxPackage(calibration: ModelPackage["output_spec"]["calibration"], temperature = 1): string {
  const dir = copyFixture();
  const def = {
    input_dim: 4,
    layers: [
      { type: "linear", in_features: 4, out_features: 6 },
      { type: "activation", function: "tanh" },
      { type: "linear", in_features: 6, out_features: 3 },
    ],
  };
  const trainer = wasm.Trainer.fromNetworkDefSeeded(JSON.stringify(def), 7);
  const weights = trainer.get_weights();
  const layout = trainer.paramShapes().map((p) => ({ name: p.name, shape: p.shape, offset: p.offset, length: p.len }));
  writeFileSync(join(dir, "network_def.json"), trainer.networkDefJson());

  const m = readJson<ModelPackage>(dir, "model.json");
  const inputs = readJson<Golden>(dir, "golden.json").cases.map((c) => c.input);
  const ref = createPredictor(JSON.parse(trainer.networkDefJson()), weights, { head: "none" });
  const fs = m.feature_spec;
  const norm = fs.normalization.kind === "zscore" ? fs.normalization : undefined;
  const cases = inputs.map((x, i) => {
    const z = Float32Array.from(x, (v, c) => (norm ? (v - (norm.mean[c] as number)) / ((norm.std[c] as number) + norm.eps) : v));
    const raw = Array.from(ref.predictLogits(z));
    const e = raw.map((v) => Math.exp(v / temperature - Math.max(...raw.map((r) => r / temperature))));
    const sum = e.reduce((a, b) => a + b, 0);
    return { name: `case${i}`, input: x, raw, score: e.map((v) => v / sum) };
  });
  const golden: Golden = {
    format: "gran-prix.golden",
    format_version: "1.0.0",
    weights_sha256: sha256Of(new Uint8Array(weights.buffer.slice(0))),
    tolerance: { abs: 1e-5 },
    cases,
  };
  reseal(dir, {
    weights,
    golden,
    model: (mm) => {
      mm.network.output_dim = 3;
      mm.network.param_layout = layout;
      mm.files.weights.count = weights.length;
      mm.output_spec = { activation: "softmax", labels: ["noise", "support", "main"], calibration };
      mm.requires.layer_types = ["linear", "activation"];
    },
  });
  return dir;
}

describe("softmax output with temperature calibration", () => {
  for (const runtime of ["ts", "wasm"] as Runtime[]) {
    it(`passes the nine checks and reproduces golden (runtime ${runtime})`, () => {
      const dir = softmaxPackage({ kind: "temperature", t: 2 }, 2);
      const m = loadModelPackage(dir, { runtime });
      expect(m.outputDim).toBe(3);
      const probs = m.predictProbs([0.6, 0.1, 1, 0.0625]);
      expect(probs.length).toBe(3);
      expect(Array.from(probs).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
      m.dispose();
    });
  }

  it("the wasm runtime calibrates raw logits: same scores as ts, also where the softmax saturates", () => {
    const dir = softmaxPackage({ kind: "temperature", t: 2 }, 2);
    const ts = loadModelPackage(dir, { runtime: "ts" });
    const wasmRt = loadModelPackage(dir, { runtime: "wasm" });
    // Far outside the training range: the uncalibrated head is saturated (probabilities ~0 / ~1).
    const rows = [60, -45, 80, 30, -70, 90, -55, 40, 0.6, 0.1, 1, 0.0625];
    const a = ts.predictBatch(rows, 3);
    const b = wasmRt.predictBatch(rows, 3);
    expect(a.length).toBe(9);
    a.forEach((v, i) => expect(Math.abs(v - (b[i] as number))).toBeLessThan(1e-6));
    ts.dispose();
    wasmRt.dispose();
  });

  it("a golden that ignores the temperature fails check 9", () => {
    const dir = softmaxPackage({ kind: "temperature", t: 2 }, 1);
    expect(() => loadModelPackage(dir)).toThrow(ModelPackageError);
    try {
      loadModelPackage(dir);
    } catch (e) {
      expect((e as ModelPackageError).check).toBe("golden");
    }
  });

  it("uncalibrated softmax package loads", () => {
    loadModelPackage(softmaxPackage({ kind: "none" }, 1)).dispose();
  });
});

describe("platt calibration on a sigmoid package", () => {
  it("the fixture's platt(a=1,b=0) is neutral; a changed platt needs a matching golden", () => {
    const dir = copyFixture();
    reseal(dir, { model: (m) => void (m.output_spec.calibration = { kind: "platt", a: 2, b: 0.5 }) });
    expect(() => loadModelPackage(dir)).toThrow(/golden/);
    loadModelPackage(FIXTURE_DIR).dispose();
  });
});
