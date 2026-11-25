import { describe, expect, it } from "vitest";
import {
  ARTIFACT_CONTRACTS,
  CONTRACTS,
  CONTRACT_SET_VERSION,
  ID_SCHEME,
  STAGE_KINDS,
  assertValid,
  compare,
  contractByName,
  contractId,
  jsonSchemaOf,
  stageCacheKey,
  validate,
  type Comparator,
} from "../src/index.js";
import { kappaResult } from "../src/tools/fixtures/audit-docs.js";
import { sha } from "../src/tools/fixtures/extract-docs.js";
import { buildUniverse, EXTRA_VALID } from "../src/tools/fixtures/universe.js";

const u = buildUniverse();

describe("v1.1 contract set", () => {
  it("per-contract versions follow the policy (MINOR for optional fields / new enum values, PATCH for a clarification)", () => {
    const v = Object.fromEntries(CONTRACTS.map((c) => [c.name, c.version]));
    expect(v).toMatchObject({
      "eval-report": "1.1.0",
      "page-snapshot": "1.1.0",
      "feature-schema": "1.1.0",
      "dataset-manifest": "1.1.0",
      "dataset-row": "1.1.0",
      "stage-kind-spec": "1.1.0",
      "pipeline-spec": "1.1.0",
      "model-package": "1.1.0",
      "node-features": "1.0.1",
      "label-agreement": "1.0.0",
      "qa-task-set": "1.0.0",
      // untouched by v1.1
      golden: "1.0.0",
      "train-config": "1.0.0",
      "node-labels": "1.0.0",
      "content-tree": "1.0.0",
      "network-def": "1.0.0",
    });
    expect(CONTRACT_SET_VERSION).toBe("1.1.0");
  });

  it("the committed schema of each contract carries the same version as the registry", () => {
    for (const c of CONTRACTS) expect((jsonSchemaOf(c.name) as { "x-gran-prix": { version: string } })["x-gran-prix"].version).toBe(c.version);
  });

  it("every extra valid fixture (downstream report, demo stage kind and pipeline) validates", () => {
    expect(EXTRA_VALID.length).toBeGreaterThanOrEqual(3);
    for (const e of EXTRA_VALID) expect(validate(e.contract, e.pick(u)).issues, e.path).toEqual([]);
  });

  it("the new artifact types map to the new contracts", () => {
    expect(ARTIFACT_CONTRACTS.LabelAgreement).toBe("label-agreement");
    expect(ARTIFACT_CONTRACTS.QaTaskSet).toBe("qa-task-set");
  });

  it("new contracts are identified like the other produced artifacts (own id field, provenance excluded)", () => {
    const a = u.labelAgreement as unknown as Record<string, unknown>;
    expect(contractId("label-agreement", a)).toBe(u.labelAgreement.agreement_id);
    expect(contractId("label-agreement", { ...a, provenance: { other: true } })).toBe(u.labelAgreement.agreement_id);
    const q = u.qaTaskSet as unknown as Record<string, unknown>;
    expect(contractId("qa-task-set", q)).toBe(u.qaTaskSet.task_set_id);
    expect(contractByName("label-agreement").format).toBe("gran-prix.label-agreement");
  });
});

describe("StageKind demo and the tool hash of the stage cache key", () => {
  it("`demo` is a stage kind, and the spec / pipeline that use it validate", () => {
    expect(STAGE_KINDS).toContain("demo");
    expect(validate("stage-kind-spec", u.demoKind).ok).toBe(true);
    expect(validate("pipeline-spec", u.demoPipeline).ok).toBe(true);
  });

  const base = { impl: "rust:train.gp-train@1.0.0", params: { seed: 1 }, inputIds: { dataset: sha("ds") } };

  it("toolSha changes the key, and is part of it only when given (existing keys do not move)", () => {
    const without = stageCacheKey(base);
    expect(stageCacheKey({ ...base, toolSha: sha("bin-a") })).not.toBe(without);
    expect(stageCacheKey({ ...base, toolSha: sha("bin-a") })).not.toBe(stageCacheKey({ ...base, toolSha: sha("bin-b") }));
    expect(stageCacheKey({ ...base, toolSha: sha("bin-a") })).toBe(stageCacheKey({ ...base, toolSha: sha("bin-a") }));
    // A pinned v1.0 key: absence of toolSha must reproduce the exact v1.0 value.
    expect(stageCacheKey({ impl: "ts:label.heuristic@1.0.0", params: { confidence: 0.8 }, inputIds: { snapshots: sha("s") } })).toBe(
      stageCacheKey({ impl: "ts:label.heuristic@1.0.0", params: { confidence: 0.8 }, inputIds: { snapshots: sha("s") }, wasmSha: undefined, nodeMajor: undefined }),
    );
  });

  it("toolSha and wasmSha are independent dimensions", () => {
    const a = stageCacheKey({ ...base, toolSha: sha("t"), wasmSha: sha("w") });
    expect(a).not.toBe(stageCacheKey({ ...base, toolSha: sha("t") }));
    expect(a).not.toBe(stageCacheKey({ ...base, wasmSha: sha("w") }));
  });

  it("rejects a malformed toolSha", () => {
    expect(() => stageCacheKey({ ...base, toolSha: "abc" as never })).toThrow(/toolSha/);
  });

  it("provenance records tool_sha256 (model-package fixture)", () => {
    expect(u.model.provenance.tool_versions.tool_sha256).toBe(sha("gp-train-binary"));
  });
});

describe("inputs of the evaluate lane", () => {
  it("evaluate registry entry: seeded, optional many `baselines` port, extra `extras` and `details` outputs", () => {
    const k = u.stageKinds.find((x) => x.kind === "evaluate");
    expect(k?.determinism).toBe("seeded");
    expect(k?.inputs.find((p) => p.name === "baselines")).toEqual({ name: "baselines", type: "Bundle", many: true, optional: true });
    expect(k?.outputs.map((p) => p.name)).toEqual(["report", "extras", "details"]);
    expect(k?.params_schema).toMatchObject({ required: ["seed"] });
  });

  it("embedded provenance may be a placeholder (the runner receipt is authoritative) and stays outside report_id", () => {
    const r = u.downstreamReport;
    expect(r.provenance.placeholder).toBe(true);
    const swapped = { ...r, provenance: { ...r.provenance, placeholder: undefined, produced_by: { ...r.provenance.produced_by, run_id: "run-77" } } };
    expect(contractId("eval-report", swapped as never)).toBe(r.report_id);
  });

  it("weighting, bootstrap and baseline coverage live under intrinsic; comparison and gates carry the aggregation", () => {
    const i = u.evalReport.intrinsic!;
    expect(i.weighting).toMatchObject({ unit: "chars", positive_class: expect.any(String), weight_source: expect.any(String) });
    expect(i.bootstrap?.cluster_by).toBe("group_key");
    expect(i.baselines["readability"]?.coverage).toBe(0.97);
    expect(i.comparison[0]?.aggregation).toBe("macro_page");
    expect(u.evalReport.gates?.[0]).toMatchObject({ metric: "f1", baseline: "readability", aggregation: "macro_page" });
  });
});

describe("structured gates", () => {
  const cases: Array<[Comparator, number, number, boolean]> = [
    [">=", 2, 2, true], [">=", 1.99, 2, false], [">", 2, 2, false], [">", 2.01, 2, true],
    ["<=", 150, 150, true], ["<=", 151, 150, false], ["<", 150, 150, false], ["<", 149, 150, true],
    ["==", 3, 3, true], ["==", 3, 4, false],
  ];
  it.each(cases)("compare(%s): %s vs %s is %s", (cmp, v, t, expected) => expect(compare(v, cmp, t)).toBe(expected));

  it("a gate decided on the CI upper bound for <= / <", () => {
    const doc = structuredClone(u.evalReport);
    doc.gates = [
      { id: "latency_ci", rule: "upper bound <= 150", value: 140, passed: true, comparator: "<=", threshold: 150, use_ci_lower: true, ci95: [100, 140] },
    ];
    doc.report_id = contractId("eval-report", doc as never);
    expect(validate("eval-report", doc).issues).toEqual([]);
    doc.gates[0] = { ...doc.gates[0]!, value: 100 };
    doc.report_id = contractId("eval-report", doc as never);
    expect(validate("eval-report", doc).issues.map((i) => i.path)).toContain("gates[0].value");
  });

  it("a v1.0 gate (id, rule, value, passed) is still a gate: the structured fields are all optional", () => {
    const g = u.evalReport.gates?.find((x) => x.id === "f1_vs_readability");
    expect(g).toEqual({ id: "f1_vs_readability", rule: "macro_f1_delta >= 0", value: expect.any(Number), passed: true });
  });
});

describe("PageSnapshot v1.1", () => {
  it("makes the id scheme normative: probe.id_scheme is the literal gp-composed-preorder/1", () => {
    expect(ID_SCHEME).toBe("gp-composed-preorder/1");
    expect(u.snapshot.probe?.id_scheme).toBe(ID_SCHEME);
  });

  it("text unit ids follow the composed order: interleaved with their owners in pre-order, increasing child index per owner", () => {
    const units = u.snapshot.text_units ?? [];
    expect(units.map((t) => t.id)).toEqual(["n2#t0", "n3#t0", "n4#t0", "n7#t0"]);
    expect(units.every((t) => u.snapshot.nodes[t.owner] !== undefined)).toBe(true);
  });

  it("carries the disclosure flag, the form type, role, href and id attributes", () => {
    const nodes = u.snapshot.nodes;
    expect(nodes[7]?.flags.disclosure).toBe(true);
    expect(nodes[5]?.attrs.type).toBe("search");
    expect(nodes[4]?.attrs.href).toBe("/next");
    expect(nodes[4]?.attrs.role).toBe("link");
    expect(nodes[2]?.attrs.id).toBe("title");
  });

  it("settle and network are in capture, hence outside snapshot_id", () => {
    const d = structuredClone(u.snapshot) as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    d["capture"].settle.waited_ms = 9999;
    d["capture"].network = "timeout";
    expect(contractId("page-snapshot", d)).toBe(u.snapshot.snapshot_id);
    d["probe"].own_text_cap = 999;
    expect(contractId("page-snapshot", d)).not.toBe(u.snapshot.snapshot_id); // probe is part of the identity
  });

  it("a snapshot without any v1.1 field is still a valid snapshot", () => {
    const d = structuredClone(u.snapshot) as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const k of ["text_units", "probe"]) delete d[k];
    delete d["page"].og_type;
    delete d["page"].jsonld_types;
    delete d["capture"].settle;
    delete d["capture"].network;
    for (const n of d["nodes"]) delete n.flags.disclosure;
    d["format_version"] = "1.0.0";
    d["snapshot_id"] = contractId("page-snapshot", d);
    expect(validate("page-snapshot", d).issues).toEqual([]);
  });
});

describe("FeatureSchema / NodeFeatures / Dataset v1.1", () => {
  it("context feature: copies a finished value of a non-context feature at the parent / prev / next node", () => {
    const f = u.schema.features[3];
    expect(f?.context).toEqual({ rel: "parent", source: "link_density" });
  });

  it("NodeFeatures unit_ids are exactly the non-prefiltered nodes (fixture is consistent with the normative text)", () => {
    const f = u.features;
    const prefiltered = Object.values(f.prefiltered).reduce((a, b) => a + b, 0);
    expect(f.unit_ids.length).toBe(f.n_nodes_total - prefiltered);
    expect(f.unit_ids).not.toContain(8); // the <script>
    expect(f.unit_ids).not.toContain(7); // the unrendered <p>
  });

  it("dataset rows carry the char weight declared by row_weight, and tags are recomputable", () => {
    expect(u.dataset.manifest.row_weight).toBe("own_text_chars");
    expect(u.dataset.rows.every((r) => typeof r.w === "number")).toBe(true);
    expect(u.dataset.manifest.groups.every((g) => (g.tags ?? []).length > 0)).toBe(true);
    expect(Object.keys(u.dataset.manifest.stats.by_tag ?? {}).sort()).toEqual(["lang:en", "lang:pt", "logged_in"]);
  });
});

describe("LabelAgreement (C0) and QaTaskSet (C10)", () => {
  it("kappa is Cohen's: perfect agreement is 1, chance-level agreement is 0", () => {
    expect(kappaResult("binary", "elements", ["drop", "keep"], [[10, 0], [0, 10]], 1).kappa).toBe(1);
    expect(kappaResult("binary", "elements", ["drop", "keep"], [[5, 5], [5, 5]], 1).kappa).toBe(0);
    expect(kappaResult("binary", "elements", ["drop", "keep"], [[0, 10], [10, 0]], 1).kappa).toBe(-1);
  });

  it("the valid audit validates and its gates agree with its kappa", () => {
    const a = assertValid("label-agreement", u.labelAgreement);
    expect(a.pairs[0]?.results.map((r) => `${r.space}/${r.weighting}`)).toEqual(["binary/elements", "three_class/elements", "binary/chars"]);
    expect(a.gates?.every((g) => g.passed)).toBe(true);
  });

  it("QA evidence can never be noise: the schema has no such class", () => {
    const schema = JSON.stringify(jsonSchemaOf("qa-task-set").properties);
    expect(schema).toContain('"const":"support"');
    expect(schema).not.toContain('"const":"noise"');
  });
});
