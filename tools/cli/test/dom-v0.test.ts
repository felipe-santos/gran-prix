// The E1 gate pipeline and the contracts example, checked against the REAL stages (no Chromium, no binaries).
// The end-to-end run is `node scripts/gate-e1.mjs`.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LABEL_SOURCES, type PipelineSpec, type StageKindSpec } from "@gran-prix/contracts";
import { describe, expect, it } from "vitest";
import { StageRegistry, checkPipeline } from "../src/index.js";
import { ALL_STAGES } from "../src/stages/index.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const readJson = <T>(p: string): T => JSON.parse(readFileSync(join(REPO, p), "utf8")) as T;
const registry = new StageRegistry(ALL_STAGES);

const dom = readJson<PipelineSpec>("pipelines/dom-v0.json");
const example = readJson<PipelineSpec>("packages/contracts/fixtures/valid/pipeline-spec.json");
const exampleRegistry = readJson<StageKindSpec[]>("packages/contracts/fixtures/valid/pipeline-registry.json");
const stems = readdirSync(join(REPO, "fixtures/pages"))
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.replace(/\.html$/, ""))
  .sort();
const truthOf = (stem: string) => readJson<{ category: string; rules: unknown[] }>(`fixtures/pages/${stem}.truth.json`);
const stage = (id: string) => dom.stages.find((s) => s.id === id) as PipelineSpec["stages"][number] & { params: Record<string, any> };

describe("pipelines/dom-v0.json", () => {
  it("passes the same check as `gp validate` against the real stage registry", () => {
    const r = checkPipeline(dom, registry);
    expect(r.ok ? [] : r.issues).toEqual([]);
  });

  it("wires collect -> extract -> label (truth + readability) -> merge -> dataset -> train -> package -> evaluate", () => {
    expect(dom.stages.map((s) => s.impl)).toEqual([
      "ts:collect.playwright@1.0.0",
      "ts:extract.dom-node@1.0.0",
      "ts:label.truth@1.0.0",
      "ts:label.heuristic@1.0.0",
      "ts:label.merge@1.0.0",
      "ts:dataset.jsonl@1.0.0",
      "rust:train.gp-train@1.0.0",
      "ts:package.bundle@1.0.0",
      "ts:evaluate.intrinsic@1.0.0",
    ]);
    expect(stage("label_merge").inputs["layers"]).toEqual([
      { stage: "label_truth", output: "labels" },
      { stage: "label_heuristic", output: "labels" },
    ]);
    expect(stage("train").inputs).toEqual({ dataset: { stage: "dataset", output: "dataset" }, config: { external: "train_config" } });
    expect(stage("evaluate").inputs["model"]).toEqual({ stage: "train", output: "model" });
    // seeds are vars; the pinned capture time keeps the SnapshotSet id reproducible
    expect(dom.vars).toMatchObject({ seed: 42 });
    expect(stage("train").params["seed"]).toBe("${vars.seed}");
    expect(stage("evaluate").params["seed"]).toBe("${vars.seed}");
    expect(stage("collect").params["captured_at"]).toBeTypeOf("string");
    expect(stage("evaluate").params["gates"]).toEqual([]);
  });

  it("its externals are the schema v0, the URL list of the 12 fixtures with their stratum, and the TrainConfig", () => {
    for (const e of Object.values(dom.externals ?? {})) expect(existsSync(resolve(REPO, e.path as string)), e.path).toBe(true);
    expect(dom.externals?.["schema"]?.path).toBe("packages/features/src/schema/feature-schema.v0.json");
    const urls = readJson<Array<{ url: string; stratum: string }>>(dom.externals?.["urls"]?.path as string);
    expect(urls.map((u) => u.url)).toEqual(stems.map((s) => `fixtures/pages/${s}.html`));
    expect(urls.map((u) => u.stratum)).toEqual(stems.map((s) => truthOf(s).category));
    const cfg = readJson<{ data: { allowed_sources: string[] }; train_config_id: string }>(dom.externals?.["train_config"]?.path as string);
    // the sources the labels can carry here (human truth, Readability, its h1 rule) must all be trainable
    for (const s of ["human", "readability", "rule"]) expect(cfg.data.allowed_sources).toContain(s);
    for (const s of cfg.data.allowed_sources) expect(LABEL_SOURCES as readonly string[]).toContain(s);
  });

  it("carries the human truth of every fixture page (inline rules equal fixtures/pages/*.truth.json)", () => {
    const pages = stage("label_truth").params["pages"] as Array<{ url_contains: string; rules: unknown[] }>;
    expect(pages.map((p) => p.url_contains)).toEqual(stems.map((s) => `/${s}.html`));
    for (const [i, s] of stems.entries()) expect(pages[i]?.rules, s).toEqual(truthOf(s).rules);
  });

  it("splits the 12 groups so that train, val and test all get groups, and every test group has human labels", () => {
    const overrides = stage("dataset").params["split"].overrides as Record<string, string>;
    expect(Object.keys(overrides).sort()).toEqual(stems); // group = file stem
    const by = (name: string) => Object.entries(overrides).filter(([, v]) => v === name).map(([k]) => k);
    expect(by("train").length).toBeGreaterThanOrEqual(1);
    expect(by("val").length).toBeGreaterThanOrEqual(1);
    expect(by("test").length).toBeGreaterThanOrEqual(2);
    expect(Object.values(overrides).every((v) => ["train", "val", "test"].includes(v))).toBe(true);
    const truthStems = new Set((stage("label_truth").params["pages"] as Array<{ url_contains: string }>).map((p) => p.url_contains.replace(/^\/|\.html$/g, "")));
    for (const g of by("test")) expect(truthStems.has(g), g).toBe(true);
    // the test strata of the evaluation are not a single page type
    expect(new Set(by("test").map((g) => truthOf(g).category)).size).toBeGreaterThanOrEqual(2);
  });
});

describe("the contracts example (packages/contracts/fixtures/valid)", () => {
  it("passes the same check as `gp validate` against the real stage registry", () => {
    const r = checkPipeline(example, registry);
    expect(r.ok ? [] : r.issues).toEqual([]);
  });

  it("its registry names the real stages: same impl, kind, ports, runtime, determinism and map_over", () => {
    for (const k of exampleRegistry) {
      const real = registry.get(k.impl);
      expect(real, k.impl).toBeDefined();
      expect(
        { kind: k.kind, inputs: k.inputs, outputs: k.outputs, runtime: k.runtime, determinism: k.determinism, map_over: k.map_over },
        k.impl,
      ).toEqual({
        kind: real?.spec.kind,
        inputs: real?.spec.inputs,
        outputs: real?.spec.outputs,
        runtime: real?.spec.runtime,
        determinism: real?.spec.determinism,
        map_over: real?.spec.map_over,
      });
    }
  });

  it("the example uses the real trainer and has a package stage", () => {
    expect(example.stages.map((s) => s.impl)).toContain("rust:train.gp-train@1.0.0");
    expect(example.stages.map((s) => s.impl)).toContain("ts:package.bundle@1.0.0");
    expect(example.stages.map((s) => s.impl).join(" ")).not.toMatch(/wasm-trainer/);
  });
});
