import { describe, expect, it } from "vitest";
import {
  artifactHex,
  artifactId,
  assertSha256,
  contractId,
  identityPayload,
  llmCacheKey,
  modelId,
  sha256Hex,
  sha256Of,
  stageCacheKey,
  type ModelPackage,
} from "../src/index.js";
import { buildUniverse } from "../src/tools/fixtures/universe.js";

const u = buildUniverse();

describe("artifactId", () => {
  // Cross-checked outside this repo: `printf '%s' '<canonical>' | sha256sum` and python hashlib.
  const sample = { n: 1.5e-7, b: [1, 2, { d: null, c: true }], a: "é" };
  const canonical = '{"a":"é","b":[1,2,{"c":true,"d":null}],"n":1.5e-7}';
  const knownHex = "11d0fdf7fc09a88752916bda6a40d52302fed99100fe497bb42c572e929e266f";

  it("is sha256 of the canonical JSON, with the sha256: prefix", () => {
    expect(artifactId(sample)).toBe(`sha256:${knownHex}`);
    expect(artifactHex(sample)).toBe(knownHex);
    expect(sha256Hex(canonical)).toBe(knownHex);
  });

  it("known hashes of trivial values", () => {
    expect(artifactHex({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    expect(artifactHex([])).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
  });

  it("is independent of key order and of undefined members; sensitive to every value", () => {
    expect(artifactId({ a: 1, b: 2 })).toBe(artifactId({ b: 2, a: 1 }));
    expect(artifactId({ a: 1, b: undefined })).toBe(artifactId({ a: 1 }));
    expect(artifactId({ a: 1 })).not.toBe(artifactId({ a: 1.0000000000000002 }));
    expect(artifactId([1, 2])).not.toBe(artifactId([2, 1]));
  });

  it("refuses to hash non-JSON values instead of coercing them", () => {
    expect(() => artifactId({ a: NaN })).toThrow();
  });

  it("sha256Of hashes raw bytes (used for weights.f32le)", () => {
    expect(sha256Of(new Uint8Array([0, 1, 2]))).toBe(`sha256:${sha256Hex(new Uint8Array([0, 1, 2]))}`);
    expect(sha256Of("abc")).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("contractId: what is excluded from identity", () => {
  it("snapshot: capture metadata does not change snapshot_id, page content does", () => {
    const s = structuredClone(u.snapshot);
    s.capture.captured_at = "2030-01-01T00:00:00Z";
    s.capture.user_agent = "other";
    expect(contractId("page-snapshot", s)).toBe(u.snapshot.snapshot_id);
    s.page.title = "changed";
    expect(contractId("page-snapshot", s)).not.toBe(u.snapshot.snapshot_id);
  });

  it("feature schema: description and per-feature docs are outside the id; names and transforms are inside", () => {
    const s = structuredClone(u.schema);
    s.description = "rewritten";
    s.features.forEach((f) => (f.doc = `new doc for ${f.name}`));
    expect(contractId("feature-schema", s)).toBe(u.schema.schema_id);
    s.features[0] = { ...s.features[0]!, name: "renamed" };
    expect(contractId("feature-schema", s)).not.toBe(u.schema.schema_id);
  });

  it("dataset and eval report: provenance is outside the id", () => {
    const r = structuredClone(u.evalReport);
    r.provenance.created_at = "2031-01-01T00:00:00Z";
    r.provenance.produced_by.run_id = "run-9999";
    expect(contractId("eval-report", r)).toBe(u.evalReport.report_id);
    r.threshold = 0.6;
    expect(contractId("eval-report", r)).not.toBe(u.evalReport.report_id);
  });

  it("pipeline spec: editor layout is outside the id", () => {
    const p = structuredClone(u.pipeline);
    const before = contractId("pipeline-spec", p);
    p.layout = { collect: { x: 999, y: 999 } };
    expect(contractId("pipeline-spec", p)).toBe(before);
    p.name = "other";
    expect(contractId("pipeline-spec", p)).not.toBe(before);
  });

  it("identityPayload drops the id field itself", () => {
    expect("schema_id" in identityPayload("feature-schema", { ...u.schema })).toBe(false);
  });
});

describe("modelId (ADR-003: identity = behavior)", () => {
  const base = u.model;

  it("is stable under metrics, provenance, name, description and golden changes", () => {
    const m: ModelPackage = structuredClone(base);
    m.metrics = { eval_report_id: artifactId("other-report"), headline: { f1: 0.01 } };
    m.provenance.created_at = "2040-01-01T00:00:00Z";
    m.provenance.produced_by.run_id = "another-run";
    m.name = "renamed";
    m.description = "new description";
    m.digest.golden = sha256Of("different golden bytes");
    m.format_version = "1.7.0";
    expect(modelId(m)).toBe(base.model_id);
  });

  it.each([
    ["weights digest", (m: ModelPackage) => void (m.digest.weights = sha256Of("w2"))],
    ["network_def digest", (m: ModelPackage) => void (m.digest.network_def = sha256Of("n2"))],
    ["threshold accept", (m: ModelPackage) => void (m.thresholds.accept = 0.71)],
    ["threshold margin", (m: ModelPackage) => void (m.thresholds.margin = 0.2)],
    ["calibration", (m: ModelPackage) => void (m.output_spec.calibration = { kind: "none" })],
    ["normalization mean", (m: ModelPackage) => void ((m.feature_spec.normalization as { mean: number[] }).mean[0] = 0.51)],
    ["ood range", (m: ModelPackage) => void (m.feature_spec.ood.hi[0] = 2)],
    ["feature schema id", (m: ModelPackage) => void (m.feature_spec.schema_id = sha256Of("s2"))],
    ["required runtime", (m: ModelPackage) => void (m.requires.runtime.wasm_abi = "gran-prix-wasm@0.2")],
    ["task", (m: ModelPackage) => void (m.task.name = "other-task")],
  ])("changes when %s changes", (_what, mutate) => {
    const m: ModelPackage = structuredClone(base);
    mutate(m);
    expect(modelId(m)).not.toBe(base.model_id);
  });

  it("matches the fixture's stored model_id", () => {
    expect(modelId(base)).toBe(base.model_id);
  });
});

describe("stageCacheKey", () => {
  const A = sha256Of("a");
  const B = sha256Of("b");

  it("has a stable known value (cross-checked with python hashlib over the canonical text)", () => {
    expect(stageCacheKey({ impl: "ts:x@1.0.0", params: { b: 1, a: [1, 2] }, inputIds: { in: A } })).toBe(
      "sha256:53859208198f2cbfc1571f9043a8b4eafa4606d7c682c170a49ebad31e596c8c",
    );
  });

  it("ignores key order of params and of input ports", () => {
    const k1 = stageCacheKey({ impl: "i@1.0.0", params: { x: 1, y: 2 }, inputIds: { p: A, q: B } });
    const k2 = stageCacheKey({ impl: "i@1.0.0", params: { y: 2, x: 1 }, inputIds: { q: B, p: A } });
    expect(k1).toBe(k2);
  });

  it.each([
    ["impl version", { impl: "i@1.0.1" }],
    ["a param", { params: { x: 2 } }],
    ["an input id", { inputIds: { p: B } }],
    ["the wasm sha", { wasmSha: B }],
    ["node major", { nodeMajor: 22 }],
    ["kind", { kind: "label" }],
  ])("changes when %s changes", (_what, patch) => {
    const base = { impl: "i@1.0.0", params: { x: 1 }, inputIds: { p: A }, wasmSha: A };
    expect(stageCacheKey({ ...base, ...patch })).not.toBe(stageCacheKey(base));
  });

  it("treats the order of a many-port as significant", () => {
    const k1 = stageCacheKey({ impl: "i@1.0.0", params: {}, inputIds: { layers: [A, B] } });
    const k2 = stageCacheKey({ impl: "i@1.0.0", params: {}, inputIds: { layers: [B, A] } });
    expect(k1).not.toBe(k2);
  });

  it("an absent wasm sha is not the same as a present one, and adding it later does not alias", () => {
    const without = stageCacheKey({ impl: "i@1.0.0", params: {}, inputIds: {} });
    const withWasm = stageCacheKey({ impl: "i@1.0.0", params: {}, inputIds: {}, wasmSha: A });
    expect(without).not.toBe(withWasm);
  });

  it("rejects malformed ids and non-finite params", () => {
    expect(() => stageCacheKey({ impl: "i", params: {}, inputIds: { p: "sha256:xyz" as never } })).toThrow(TypeError);
    expect(() => stageCacheKey({ impl: "i", params: { lr: NaN }, inputIds: {} })).toThrow();
    expect(() => stageCacheKey({ impl: "", params: {}, inputIds: {} })).toThrow(/impl/);
  });

  it("assertSha256 explains what it expected", () => {
    expect(() => assertSha256("deadbeef", "wasmSha")).toThrow(/wasmSha must match/);
  });
});

describe("llmCacheKey", () => {
  const input = {
    provider: "anthropic",
    model: "model-x",
    promptSha256: sha256Of("prompt"),
    inputSha256: sha256Of("input"),
    params: { temperature: 0, max_tokens: 1024 },
    outputContract: "keep_drop_lines@1",
  };
  it("is deterministic and sensitive to the model and the input", () => {
    expect(llmCacheKey(input)).toBe(llmCacheKey({ ...input }));
    expect(llmCacheKey({ ...input, model: "model-y" })).not.toBe(llmCacheKey(input));
    expect(llmCacheKey({ ...input, inputSha256: sha256Of("input2") })).not.toBe(llmCacheKey(input));
  });
});
