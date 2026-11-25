import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Golden, ModelPackage } from "@gran-prix/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { CHECKS, ModelPackageError, loadModelPackage, type CheckId } from "../src/index.js";
import { cleanupTmp, copyFixture, overwrite, readJson, reseal } from "./helpers.js";

afterAll(cleanupTmp);

/** Loads `dir`, expects a ModelPackageError of exactly this check and returns it. */
function expectFailure(dir: string, check: CheckId, text?: RegExp): ModelPackageError {
  let err: unknown;
  try {
    loadModelPackage(dir).dispose();
  } catch (e) {
    err = e;
  }
  expect(err, `expected check "${check}" to fail`).toBeInstanceOf(ModelPackageError);
  const e = err as ModelPackageError;
  expect(e.check).toBe(check);
  expect(e.checkNumber).toBe(CHECKS.find((c) => c.id === check)?.n);
  expect(e.message).toContain(`"${check}"`);
  if (text) expect(e.details.join("\n")).toMatch(text);
  return e;
}

const fixtureDef = (): { input_dim: number; layers: Array<Record<string, unknown>> } =>
  JSON.parse(readFileSync(join(copyFixture(), "network_def.json"), "utf8")) as never;

describe("check 1: manifest", () => {
  it("rejects a model.json that is not JSON", () => {
    const d = copyFixture();
    overwrite(d, "model.json", "{ not json");
    expectFailure(d, "manifest", /not valid JSON/);
  });

  it("rejects a missing model.json", () => {
    const d = copyFixture();
    rmSync(join(d, "model.json"));
    expectFailure(d, "manifest", /cannot read model.json/);
  });

  it("rejects a document the contract refuses (schema)", () => {
    const d = copyFixture();
    const m = readJson<Record<string, unknown>>(d, "model.json");
    delete m["thresholds"];
    overwrite(d, "model.json", JSON.stringify(m));
    expectFailure(d, "manifest", /thresholds/);
  });

  it("rejects a stale model_id (identity = behavior)", () => {
    const d = copyFixture();
    const m = readJson<ModelPackage>(d, "model.json");
    m.thresholds.accept = 0.9; // changes behavior, model_id left alone
    overwrite(d, "model.json", JSON.stringify(m));
    expectFailure(d, "manifest", /model_id/);
  });

  it("refuses an unknown extension and an unknown wasm ABI", () => {
    const a = copyFixture();
    reseal(a, { model: (m) => void (m.requires.extensions = ["quantized-int8"]) });
    expectFailure(a, "manifest", /unknown extension.*quantized-int8/);
    const b = copyFixture();
    reseal(b, { model: (m) => void (m.requires.runtime.wasm_abi = "gran-prix-wasm@9.9") });
    expectFailure(b, "manifest", /wasm_abi/);
  });
});

describe("check 2: files", () => {
  it("rejects a missing referenced file", () => {
    const d = copyFixture();
    rmSync(join(d, "weights.f32le"));
    expectFailure(d, "files", /weights.f32le.*does not exist/);
  });

  it("rejects a file whose size differs from the declared bytes", () => {
    const d = copyFixture();
    overwrite(d, "golden.json", readFileSync(join(d, "golden.json"), "utf8") + " ");
    expectFailure(d, "files", /golden.json.*bytes/);
  });
});

describe("check 3: digests", () => {
  it("rejects weights corrupted in place (same size, different bytes)", () => {
    const d = copyFixture();
    const w = new Uint8Array(readFileSync(join(d, "weights.f32le")));
    w[10] = (w[10] as number) ^ 0xff;
    overwrite(d, "weights.f32le", w);
    expectFailure(d, "digests", /weights.f32le: sha256/);
  });

  it("rejects a golden.json edited in place", () => {
    const d = copyFixture();
    const text = readFileSync(join(d, "golden.json"), "utf8");
    overwrite(d, "golden.json", text.replace("row0", "rowX"));
    expectFailure(d, "digests", /golden.json: sha256/);
  });
});

describe("check 4: network_def digest", () => {
  it("rejects a network_def.json whose canonical hash differs (same size)", () => {
    const d = copyFixture();
    overwrite(d, "network_def.json", readFileSync(join(d, "network_def.json"), "utf8").replace("relu", "tanh"));
    expectFailure(d, "network-def-digest", /canonical hash/);
  });

  it("rejects a network_def.json that is not JSON", () => {
    const d = copyFixture();
    const len = readFileSync(join(d, "network_def.json")).byteLength;
    overwrite(d, "network_def.json", "x".repeat(len));
    expectFailure(d, "network-def-digest", /not valid JSON/);
  });

  it("is whitespace-proof: a pretty-printed network_def with the same content passes the digest", () => {
    const d = copyFixture();
    overwrite(d, "network_def.json", JSON.stringify(JSON.parse(readFileSync(join(d, "network_def.json"), "utf8")), null, 2));
    reseal(d, {}); // only sizes/ids change; the canonical digest must stay equal
    loadModelPackage(d).dispose();
  });
});

describe("check 5: validateNetworkDef", () => {
  it("rejects a network the WASM core refuses (dimension chain broken)", () => {
    const d = copyFixture();
    const def = fixtureDef();
    (def.layers[2] as { in_features: number }).in_features = 5;
    reseal(d, { networkDef: def });
    expectFailure(d, "network-def-valid", /.+/);
  });

  it("rejects a network that uses a layer type requires.layer_types does not list", () => {
    const d = copyFixture();
    const def = fixtureDef();
    def.layers.splice(2, 0, { type: "dropout", rate: 0.25 });
    reseal(d, { networkDef: def });
    expectFailure(d, "network-def-valid", /dropout.*requires.layer_types/);
  });
});

describe("check 6: dimensions", () => {
  it("rejects input_dim of the network different from feature_spec.dim", () => {
    const d = copyFixture();
    const def = fixtureDef();
    def.input_dim = 5;
    (def.layers[0] as { in_features: number }).in_features = 5;
    reseal(d, { networkDef: def });
    expectFailure(d, "dimensions", /input_dim is 5/);
  });

  it("rejects an output dimension the output_spec does not describe", () => {
    const d = copyFixture();
    const def = fixtureDef();
    (def.layers[2] as { out_features: number }).out_features = 2;
    reseal(d, { networkDef: def });
    expectFailure(d, "dimensions", /output/);
  });
});

describe("check 7: weights length and layout", () => {
  it("rejects weights whose length differs from the network's paramCount", () => {
    const d = copyFixture();
    const def = fixtureDef();
    (def.layers[0] as { out_features: number }).out_features = 4;
    (def.layers[2] as { in_features: number }).in_features = 4;
    reseal(d, { networkDef: def });
    expectFailure(d, "weights-layout", /paramCount 25/);
  });

  it("rejects a param_layout that disagrees with paramShapes()", () => {
    const d = copyFixture();
    reseal(d, {
      model: (m) => {
        const w = m.network.param_layout[0];
        if (w) w.shape = [3, 4]; // same length (12), wrong orientation
      },
    });
    expectFailure(d, "weights-layout", /param_layout\[0\]/);
  });
});

describe("check 8: round trip", () => {
  it("rejects a network_def with a field the runtime silently ignores", () => {
    const d = copyFixture();
    const def = fixtureDef() as Record<string, unknown>;
    def["note"] = "this field would be lost on the first trip through the Trainer";
    reseal(d, { networkDef: def });
    expectFailure(d, "round-trip", /differs from network_def.json/);
  });

  it("rejects a layer-level unknown field too", () => {
    const d = copyFixture();
    const def = fixtureDef();
    (def.layers[1] as Record<string, unknown>)["leak"] = 0.1;
    reseal(d, { networkDef: def });
    expectFailure(d, "round-trip", /differs/);
  });

  it("rejects weights that import_weights refuses (out of the sane range)", () => {
    const d = copyFixture();
    const w = new Float32Array(19).fill(0.1);
    w[3] = 1e9;
    reseal(d, { weights: w });
    expectFailure(d, "round-trip", /import_weights/);
  });
});

describe("check 9: golden.json", () => {
  const golden = (d: string): Golden => readJson<Golden>(d, "golden.json");

  it("rejects a golden score that no runtime reproduces, naming the runtimes", () => {
    const d = copyFixture();
    const g = golden(d);
    (g.cases[0] as { score: number[] }).score = [0.9];
    reseal(d, { golden: g });
    const e = expectFailure(d, "golden", /case row0/);
    expect(e.details.some((l) => l.startsWith("infer-ts score"))).toBe(true);
    expect(e.details.some((l) => l.startsWith("wasm score"))).toBe(true);
  });

  it("rejects a golden raw logit that infer-ts does not reproduce", () => {
    const d = copyFixture();
    const g = golden(d);
    (g.cases[1] as { raw: number[] }).raw = [3];
    reseal(d, { golden: g });
    expectFailure(d, "golden", /infer-ts raw/);
  });

  it("rejects a golden produced from other weights", () => {
    const d = copyFixture();
    const g = golden(d);
    g.weights_sha256 = `sha256:${"0".repeat(64)}`;
    reseal(d, { golden: g });
    expectFailure(d, "golden", /produced from weights/);
  });

  it("applies feature normalization: a golden computed without it fails", () => {
    const d = copyFixture();
    reseal(d, { model: (m) => void (m.feature_spec.normalization = { kind: "none" }) });
    expectFailure(d, "golden", /case row0/);
  });

  it("an explicit tolerance overrides the one in golden.json", () => {
    const d = copyFixture();
    const g = golden(d);
    (g.cases[0] as { score: number[] }).score = [(g.cases[0] as { score: number[] }).score[0]! + 1e-3];
    reseal(d, { golden: g });
    expectFailure(d, "golden");
    loadModelPackage(d, { tolerance: { abs: 1e-2 } }).dispose();
  });
});
