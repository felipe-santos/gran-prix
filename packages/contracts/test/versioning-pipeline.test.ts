import { describe, expect, it } from "vitest";
import {
  CONTRACTS,
  checkFormatVersion,
  compareVersions,
  contractId,
  parseSemVer,
  pipelineRegistryIssues,
  resolveVars,
  validate,
} from "../src/index.js";
import { buildUniverse } from "../src/tools/fixtures/universe.js";

const u = buildUniverse();

describe("versioning: reader rules", () => {
  it("every contract is at a 1.x version and has a unique format string", () => {
    for (const c of CONTRACTS) expect(parseSemVer(c.version)?.major).toBe(1);
    const formats = CONTRACTS.map((c) => c.format);
    expect(new Set(formats).size).toBe(formats.length);
  });

  it("accepts a newer MINOR and PATCH of the same MAJOR, ignoring unknown fields", () => {
    const doc = structuredClone(u.labels) as Record<string, unknown>;
    doc["format_version"] = "1.9.3";
    doc["new_optional_field"] = { anything: true };
    doc["labels_id"] = contractId("node-labels", doc); // unknown fields are part of the hash
    expect(validate("node-labels", doc).issues).toEqual([]);
  });

  it("accepts an older MINOR", () => {
    const doc = structuredClone(u.snapshot);
    doc.format_version = "1.0.0";
    expect(checkFormatVersion("page-snapshot", doc)).toEqual([]);
  });

  it.each(["0.9.0", "2.0.0", "10.0.0"])("refuses MAJOR %s with a version issue at format_version", (v) => {
    const doc = { ...structuredClone(u.snapshot), format_version: v };
    const r = validate("page-snapshot", doc);
    expect(r.ok).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ code: "version", path: "format_version" });
  });

  it("refuses a document of another contract, naming both formats", () => {
    const r = validate("node-features", u.snapshot);
    expect(r.issues[0]).toMatchObject({ code: "version", path: "format" });
    expect(r.issues[0]?.message).toContain("gran-prix.node-features");
  });

  it("never repairs: a malformed version is reported by the schema with its path", () => {
    const r = validate("page-snapshot", { ...u.snapshot, format_version: "one" });
    expect(r.issues.some((i) => i.path === "format_version" && i.code === "schema")).toBe(true);
  });

  it("compareVersions orders by major, minor, patch", () => {
    const p = (s: string) => parseSemVer(s)!;
    expect(compareVersions(p("1.2.3"), p("1.2.3"))).toBe(0);
    expect(compareVersions(p("1.3.0"), p("1.2.9"))).toBe(1);
    expect(compareVersions(p("0.9.9"), p("1.0.0"))).toBe(-1);
  });
});

describe("PipelineSpec validation", () => {
  const kinds = u.stageKinds;

  it("the fixture pipeline is valid structurally and against the stage registry", () => {
    expect(validate("pipeline-spec", u.pipeline).issues).toEqual([]);
    expect(pipelineRegistryIssues(u.pipeline, kinds)).toEqual([]);
  });

  it("resolveVars keeps types for whole-string placeholders and interpolates inside text", () => {
    const missing: string[] = [];
    const out = resolveVars({ seed: "${vars.seed}", name: "run-${vars.seed}", nested: ["${vars.flag}"], keep: "${vars.nope}" }, { seed: 42, flag: true }, (n) => missing.push(n));
    expect(out).toEqual({ seed: 42, name: "run-42", nested: [true], keep: "${vars.nope}" });
    expect(missing).toEqual(["nope"]);
  });

  it("a seeded stage without a seed is an error", () => {
    const spec = structuredClone(u.pipeline);
    spec.stages[4]!.params = { epochs: 30 };
    const issues = pipelineRegistryIssues(spec, kinds);
    expect(issues.map((i) => i.path)).toContain("stages[4].params.seed");
  });

  it("params that violate the kind's params_schema are reported with their path", () => {
    const spec = structuredClone(u.pipeline);
    spec.stages[0]!.params = { viewport: [1366] };
    const issues = pipelineRegistryIssues(spec, kinds);
    expect(issues.some((i) => i.code === "schema" && i.path.startsWith("stages[0].params.viewport"))).toBe(true);
  });

  it("an unresolved variable is reported", () => {
    const spec = structuredClone(u.pipeline);
    spec.stages[4]!.params = { seed: "${vars.missing}" };
    const issues = pipelineRegistryIssues(spec, kinds);
    expect(issues.some((i) => i.message.includes("unknown variable"))).toBe(true);
  });

  it("port type mismatch: a Dataset wired into a NodeFeaturesSet port", () => {
    const spec = structuredClone(u.pipeline);
    spec.stages[2]!.inputs["features"] = { stage: "dataset", output: "dataset" };
    const issues = pipelineRegistryIssues(spec, kinds);
    const hit = issues.find((i) => i.path === "stages[2].inputs.features");
    expect(hit?.message).toMatch(/Dataset.*expects NodeFeaturesSet/);
  });

  it("missing required port, unknown port, and unknown output port", () => {
    const spec = structuredClone(u.pipeline);
    delete spec.stages[1]!.inputs["schema"];
    spec.stages[1]!.inputs["bogus"] = { external: "urls" };
    spec.stages[3]!.inputs["labels"] = { stage: "label", output: "nothing" };
    const paths = pipelineRegistryIssues(spec, kinds).map((i) => i.path);
    expect(paths).toContain("stages[1].inputs.schema");
    expect(paths).toContain("stages[1].inputs.bogus");
    expect(paths).toContain("stages[3].inputs.labels");
  });

  it("external type must match the port", () => {
    const spec = structuredClone(u.pipeline);
    spec.externals!["schema"] = { type: "Dataset", id: spec.externals!["schema"]!.id! };
    const issues = pipelineRegistryIssues(spec, kinds);
    expect(issues.some((i) => i.path === "stages[1].inputs.schema" && /expects FeatureSchema/.test(i.message))).toBe(true);
  });

  it("unknown impl and kind/impl mismatch", () => {
    const spec = structuredClone(u.pipeline);
    spec.stages[2]!.impl = "ts:label.nonexistent@9.9.9";
    spec.stages[5]!.kind = "train";
    const issues = pipelineRegistryIssues(spec, kinds);
    expect(issues.some((i) => i.path === "stages[2].impl")).toBe(true);
    expect(issues.some((i) => i.path === "stages[5].kind")).toBe(true);
  });

  it("a `many` port requires an array of refs", () => {
    const merge = {
      ...kinds[2]!,
      kind: "label" as const,
      impl: "ts:label.merge@1.0.0",
      inputs: [{ name: "layers", type: "NodeLabelsSet" as const, many: true }],
      outputs: [{ name: "labels", type: "NodeLabelsSet" as const }],
      params_schema: { type: "object" },
    };
    const spec = structuredClone(u.pipeline);
    spec.stages.push({ id: "merge", kind: "label", impl: merge.impl, params: {}, inputs: { layers: { stage: "label", output: "labels" } } });
    const issues = pipelineRegistryIssues(spec, [...kinds, merge]);
    expect(issues.some((i) => i.path === "stages[6].inputs.layers" && /array/.test(i.message))).toBe(true);
    spec.stages[6]!.inputs["layers"] = [{ stage: "label", output: "labels" }];
    expect(pipelineRegistryIssues(spec, [...kinds, merge])).toEqual([]);
  });
});
