import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_NAMES,
  artifactId,
  assertValid,
  contractId,
  ContractError,
  modelId,
  sha256Of,
  validate,
  type ContractName,
  type IssueCode,
} from "../src/index.js";
import { buildInvalidCases } from "../src/tools/fixtures/invalid.js";
import { buildUniverse, VALID_PATH, validFiles } from "../src/tools/fixtures/universe.js";

const root = new URL("../fixtures/", import.meta.url).pathname;
const read = (rel: string): Buffer => readFileSync(join(root, rel));
const readJson = (rel: string): unknown => JSON.parse(read(rel).toString("utf8"));

interface Expectation {
  contract: ContractName;
  code: IssueCode;
  path: string;
  message?: string;
}
const expectations = readJson("invalid/expectations.json") as Record<string, Expectation>;

describe("valid fixtures", () => {
  it.each(CONTRACT_NAMES)("%s: the committed valid fixture passes", (name) => {
    const r = validate(name, readJson(join("valid", VALID_PATH[name])));
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("assertValid returns the typed value", () => {
    const m = assertValid("model-package", readJson("valid/model-package/model.json"));
    expect(m.thresholds.accept).toBe(0.7);
  });
});

describe("invalid fixtures", () => {
  it("every contract has at least one invalid fixture", () => {
    const covered = new Set(Object.values(expectations).map((e) => e.contract));
    for (const n of CONTRACT_NAMES) expect(covered.has(n), `no invalid fixture for ${n}`).toBe(true);
  });

  it("every file in invalid/ has an expectation, and vice versa", () => {
    const files = readdirSync(join(root, "invalid")).filter((f) => f !== "expectations.json").sort();
    expect(Object.keys(expectations).sort()).toEqual(files);
  });

  it.each(Object.entries(expectations))("%s fails with a useful path", (file, e) => {
    const r = validate(e.contract, readJson(join("invalid", file)));
    expect(r.ok, `${file} unexpectedly validated`).toBe(false);
    const hit = r.issues.find(
      (i) => i.code === e.code && i.path.startsWith(e.path) && (e.message === undefined || i.message.includes(e.message)),
    );
    expect(hit, `expected ${JSON.stringify(e)} among ${JSON.stringify(r.issues.slice(0, 6))}`).toBeDefined();
    // Every issue is attributable: contract name + non-empty path + message.
    for (const i of r.issues) {
      expect(i.contract).toBe(e.contract);
      expect(i.path.length).toBeGreaterThan(0);
      expect(i.message.length).toBeGreaterThan(0);
    }
  });

  it("assertValid throws a ContractError carrying the issues", () => {
    try {
      assertValid("feature-schema", readJson("invalid/feature-schema.duplicate-name.json"));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ContractError);
      expect((e as ContractError).issues[0]?.path).toBe("features[2].name");
      expect((e as ContractError).message).toMatch(/features\[2\]\.name/);
    }
  });

  it("empty and non-object inputs are rejected with a root path", () => {
    for (const bad of [null, 42, "x", [], {}]) {
      const r = validate("page-snapshot", bad);
      expect(r.ok).toBe(false);
    }
  });
});

describe("fixtures stay in sync with their builders", () => {
  const u = buildUniverse();
  it("committed valid files equal the builder output (run `pnpm fixtures:regen` after a contract change)", () => {
    for (const [rel, data] of validFiles(u)) {
      const onDisk = read(join("valid", rel));
      expect(Buffer.compare(onDisk, Buffer.from(data)), `fixtures/valid/${rel} is stale`).toBe(0);
    }
  });

  it("committed invalid files equal the builder output", () => {
    for (const c of buildInvalidCases(u)) {
      expect(readJson(join("invalid", c.file)), c.file).toEqual(JSON.parse(JSON.stringify(c.doc)));
      expect(expectations[c.file]).toEqual({ contract: c.contract, ...c.expect });
    }
  });
});

describe("fixture integrity: ids and digests are real", () => {
  const dir = "valid/model-package";
  const model = readJson(`${dir}/model.json`) as ReturnType<typeof buildUniverse>["model"];

  it("model.json digests match the files next to it (ADR-003 loader steps 2 and 9 inputs)", () => {
    expect(sha256Of(read(`${dir}/weights.f32le`))).toBe(model.digest.weights);
    expect(sha256Of(read(`${dir}/golden.json`))).toBe(model.digest.golden);
    expect(artifactId(readJson(`${dir}/network_def.json`))).toBe(model.digest.network_def);
    expect(read(`${dir}/weights.f32le`).byteLength).toBe(model.files.weights.bytes);
    expect(read(`${dir}/weights.f32le`).byteLength).toBe(model.files.weights.count * 4);
    expect(read(`${dir}/network_def.json`).byteLength).toBe(model.files.network_def.bytes);
    expect(read(`${dir}/golden.json`).byteLength).toBe(model.files.golden.bytes);
    expect(modelId(model)).toBe(model.model_id);
  });

  it("golden is bound to the weights and its output reproduces", () => {
    const g = readJson(`${dir}/golden.json`) as { weights_sha256: string; cases: Array<{ raw: number[]; score: number[] }> };
    expect(g.weights_sha256).toBe(model.digest.weights);
    for (const c of g.cases) expect(Math.abs(1 / (1 + Math.exp(-(c.raw[0] as number))) - (c.score[0] as number))).toBeLessThan(1e-6);
  });

  it("dataset manifest file hashes match train/val/test.jsonl and every row validates", () => {
    const m = readJson("valid/dataset/manifest.json") as ReturnType<typeof buildUniverse>["dataset"]["manifest"];
    for (const s of ["train", "val", "test"] as const) {
      const bytes = read(`valid/dataset/${s}.jsonl`);
      expect(sha256Of(bytes), s).toBe(m.files[s].sha256);
      expect(bytes.byteLength).toBe(m.files[s].bytes);
      const lines = bytes.toString("utf8").split("\n").filter(Boolean);
      expect(lines.length).toBe(m.files[s].rows);
      for (const line of lines) expect(validate("dataset-row", JSON.parse(line)).issues).toEqual([]);
    }
    expect(contractId("dataset-manifest", m as unknown as Record<string, unknown>)).toBe(m.dataset_id);
  });

  it("cross-document ids line up in the fixture universe", () => {
    const f = readJson("valid/node-features.json") as { snapshot_id: string; feature_schema_id: string };
    const s = readJson("valid/page-snapshot.json") as { snapshot_id: string };
    const sc = readJson("valid/feature-schema.json") as { schema_id: string };
    const ds = readJson("valid/dataset/manifest.json") as { feature_schema_id: string; dataset_id: string };
    const ev = readJson("valid/eval-report.json") as { model_id: string; dataset_id: string };
    expect(f.snapshot_id).toBe(s.snapshot_id);
    expect(f.feature_schema_id).toBe(sc.schema_id);
    expect(ds.feature_schema_id).toBe(sc.schema_id);
    expect(model.feature_spec.schema_id).toBe(sc.schema_id);
    expect(ev.model_id).toBe(model.model_id);
    expect(ev.dataset_id).toBe(ds.dataset_id);
  });
});
