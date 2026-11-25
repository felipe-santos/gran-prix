import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { CONTRACT_NAMES, CONTRACTS, jsonSchemaOf, validate, type ContractName, type IssueCode } from "../src/index.js";
import { compatIssues } from "./helpers/schema-compat.js";

/**
 * Backward-compatibility proof of contracts v1.1 (ADR-009). `fixtures/v1.0/` holds the fixtures and JSON Schemas
 * exactly as v1.0 shipped them; none of it is ever regenerated.
 */
const root = new URL("../fixtures/v1.0/", import.meta.url).pathname;
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), "utf8"));

/** Contracts that existed in v1.0 (the two new ones have no v1.0 documents). */
const V10_CONTRACTS = CONTRACT_NAMES.filter((n) => n !== "label-agreement" && n !== "qa-task-set");

/** The v1.0 valid fixtures, by contract (same layout as fixtures/valid at v1.0). */
const V10_VALID: Record<string, string> = {
  "page-snapshot": "page-snapshot.json",
  "feature-schema": "feature-schema.json",
  "node-features": "node-features.json",
  "node-labels": "node-labels.json",
  "dataset-manifest": "dataset/manifest.json",
  "dataset-row": "dataset-row.json",
  "network-def": "model-package/network_def.json",
  "train-config": "train-config.json",
  "model-package": "model-package/model.json",
  golden: "model-package/golden.json",
  "eval-report": "eval-report.json",
  "content-tree": "content-tree.json",
  "pipeline-spec": "pipeline-spec.json",
  "stage-kind-spec": "stage-kind-spec.json",
};

describe("v1.1 reads every v1.0 document", () => {
  it.each(V10_CONTRACTS)("%s: the v1.0 valid fixture still validates", (name) => {
    const doc = readJson(join("valid", V10_VALID[name] as string)) as { format_version?: string };
    if (name !== "dataset-row" && name !== "network-def") expect(doc.format_version, "a v1.0 fixture declares 1.0.0").toBe("1.0.0");
    const r = validate(name, doc);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("every dataset row of the v1.0 dataset still validates", () => {
    for (const split of ["train", "val", "test"]) {
      const lines = readFileSync(join(root, "valid", "dataset", `${split}.jsonl`), "utf8").split("\n").filter(Boolean);
      for (const line of lines) expect(validate("dataset-row", JSON.parse(line)).issues).toEqual([]);
    }
  });

  it("the v1.0 pipeline registry still passes the registry-dependent checks", async () => {
    const { pipelineRegistryIssues } = await import("../src/index.js");
    const issues = pipelineRegistryIssues(readJson("valid/pipeline-spec.json") as never, readJson("valid/pipeline-registry.json") as never);
    expect(issues).toEqual([]);
  });

  interface Expectation {
    contract: ContractName;
    code: IssueCode;
    path: string;
    message?: string;
  }
  const expectations = readJson("invalid/expectations.json") as Record<string, Expectation>;

  it.each(Object.entries(expectations))("%s still fails with the same issue (v1.1 did not loosen a v1.0 rule)", (file, e) => {
    const r = validate(e.contract, readJson(join("invalid", file)));
    expect(r.ok, `${file} unexpectedly validates`).toBe(false);
    const hit = r.issues.find((i) => i.code === e.code && i.path.startsWith(e.path) && (e.message === undefined || i.message.includes(e.message)));
    expect(hit, `expected ${JSON.stringify(e)} among ${JSON.stringify(r.issues.slice(0, 5))}`).toBeDefined();
  });

  it("the frozen set is complete: one v1.0 schema per v1.0 contract, 53+ invalid documents", () => {
    const files = readdirSync(join(root, "schemas")).filter((f) => f.endsWith(".json")).sort();
    expect(files).toEqual(V10_CONTRACTS.map((n) => `${n}.schema.json`).sort());
    expect(Object.keys(expectations).length).toBeGreaterThanOrEqual(53);
  });
});

describe("the v1.1 schemas are a structural superset of the v1.0 schemas", () => {
  it.each(V10_CONTRACTS)("%s: nothing the v1.0 schema accepts is refused (no new required field, no removed or narrowed one)", (name) => {
    const old = readJson(join("schemas", `${name}.schema.json`)) as Record<string, unknown>;
    expect(compatIssues(old, jsonSchemaOf(name))).toEqual([]);
  });

  it("the checker itself catches a breaking change (new required field, removed property, narrowed enum, tightened bound)", () => {
    const old = {
      type: "object",
      required: ["a"],
      properties: { a: { type: "integer", minimum: 0 }, b: { enum: ["x", "y"] }, c: { type: "string" } },
    };
    const tightened = { type: "object", required: ["a", "d"], properties: { a: { type: "integer", minimum: 1 }, b: { enum: ["x"] }, d: { type: "string" } } };
    const problems = compatIssues(old, tightened).join("\n");
    expect(problems).toContain('"d" became required');
    expect(problems).toContain('property "c" removed');
    expect(problems).toContain('enum value "y" removed');
    expect(problems).toContain("minimum tightened");
    const widened = { type: "object", required: ["a"], properties: { a: { type: "integer" }, b: { enum: ["x", "y", "z"] }, c: { type: "string" }, d: { type: "string" } } };
    expect(compatIssues(old, widened)).toEqual([]);
  });

  it("is not vacuous: the reverse direction (v1.1 -> v1.0 schema) reports the fields v1.1 added", () => {
    const v10 = readJson(join("schemas", "eval-report.schema.json")) as Record<string, unknown>;
    const reverse = compatIssues(jsonSchemaOf("eval-report"), v10).join("\n");
    expect(reverse).toContain('property "system" removed');
    expect(reverse).toContain('property "bootstrap" removed');
    expect(reverse).toContain('property "pr_curve" removed');
    expect(reverse).toContain('property "token_reduction" removed');
    expect(compatIssues(jsonSchemaOf("page-snapshot"), readJson(join("schemas", "page-snapshot.schema.json")) as Record<string, unknown>).join("\n")).toContain('property "text_units" removed');
  });
});

describe("a v1.0 reader can read v1.1 documents (forward compatibility, MINOR rule)", () => {
  const oldValidator = (name: string) => {
    const ajv = new Ajv({ strict: true, allowUnionTypes: true, allErrors: true });
    ajv.addKeyword("x-gran-prix");
    return ajv.compile(readJson(join("schemas", `${name}.schema.json`)) as object);
  };

  const current = (rel: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/valid/${rel}`, import.meta.url).pathname, "utf8"));

  it.each([
    ["page-snapshot", "page-snapshot.json"],
    ["feature-schema", "feature-schema.json"],
    ["node-features", "node-features.json"],
    ["dataset-manifest", "dataset/manifest.json"],
    ["dataset-row", "dataset-row.json"],
    ["model-package", "model-package/model.json"],
    ["eval-report", "eval-report.downstream.json"],
  ])("%s: the v1.1 fixture %s validates against the FROZEN v1.0 schema (unknown fields are ignored)", (name, file) => {
    const check = oldValidator(name);
    expect(check(current(file)), JSON.stringify(check.errors?.slice(0, 3))).toBe(true);
  });

  it("the only v1.1 fields a v1.0 schema refuses are the documented enum widenings", () => {
    const check = oldValidator("eval-report");
    expect(check(current("eval-report.json"))).toBe(false);
    const paths = (check.errors ?? []).filter((e) => e.keyword === "const").map((e) => e.instancePath);
    expect(paths.sort()).toEqual(["/intrinsic/comparison/1/metric", "/intrinsic/comparison/2/metric"]);

    const kinds = oldValidator("stage-kind-spec");
    expect(kinds(current("stage-kind-spec.demo.json"))).toBe(false);
    expect((kinds.errors ?? []).some((e) => e.instancePath === "/kind")).toBe(true);
  });

  it("every contract of the current set that existed in v1.0 kept its MAJOR", () => {
    for (const c of CONTRACTS) expect(c.version.startsWith("1.")).toBe(true);
  });
});
