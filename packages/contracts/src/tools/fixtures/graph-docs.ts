/** Synthetic fixture documents for ContentTree, StageKindSpec and PipelineSpec. */
import type { ContentTree } from "../../content-tree.js";
import type { PipelineSpec } from "../../pipeline-spec.js";
import type { PortSpec, StageKindSpec } from "../../stage-kind-spec.js";
import { sha } from "./extract-docs.js";

export function buildContentTree(modelId: ContentTree["source"]["model_id"], schemaId: ContentTree["source"]["feature_schema_id"], snapshotId: ContentTree["source"]["model_id"]): ContentTree {
  return {
    format: "gran-prix.content-tree",
    format_version: "1.0.0",
    source: {
      url: "https://a.example/post/1",
      snapshot_id: snapshotId,
      model_id: modelId,
      feature_schema_id: schemaId,
      threshold: 0.5,
      mode: "balanced",
    },
    root: [
      { kind: "heading", level: 1, src: [2], runs: [{ t: "text", text: "Example heading" }] },
      {
        kind: "paragraph",
        src: [3, 4],
        score: 0.93,
        runs: [{ t: "text", text: "Synthetic paragraph text. " }, { t: "link", href: "/next", children: [{ t: "text", text: "next" }] }],
      },
      {
        kind: "container",
        src: [],
        children: [
          { kind: "list", ordered: false, src: [5], items: [{ kind: "paragraph", src: [6], runs: [{ t: "strong", children: [{ t: "text", text: "item" }] }] }] },
          { kind: "table", src: [7], headers: ["a", "b"], rows: [["1", "2"], ["3", "4"]] },
          { kind: "code", src: [8], lang: null, text: "let x = 1;" },
          { kind: "quote", src: [9], children: [{ kind: "paragraph", src: [9], runs: [{ t: "em", children: [{ t: "text", text: "quoted" }] }] }] },
          { kind: "media", src: [10], alt: "diagram", url: "https://a.example/d.png" },
        ],
      },
    ],
    stats: { nodes_total: 11, nodes_candidates: 9, nodes_kept: 7, chars_in: 420, chars_out: 120 },
  };
}

const port = (name: string, type: PortSpec["type"], extra: Partial<PortSpec> = {}): PortSpec => ({ name, type, ...extra });
const kind = (k: Omit<StageKindSpec, "format" | "format_version">): StageKindSpec => ({
  format: "gran-prix.stage-kind-spec",
  format_version: "1.0.0",
  ...k,
});

/**
 * Registry matching `buildPipeline()`: the REAL stages of `@gran-prix/cli` (same impl ids, ports, runtime and
 * determinism; `params_schema` is the subset of the real one that the example uses). A test of the CLI checks
 * that this file and the real stage specs still agree, so the example cannot drift from the stages again.
 */
export function buildStageKinds(): StageKindSpec[] {
  return [
    kind({
      kind: "collect", impl: "ts:collect.playwright@1.0.0",
      inputs: [port("urls", "UrlList")], outputs: [port("snapshots", "SnapshotSet")],
      params_schema: {
        type: "object", required: ["viewport"],
        properties: {
          viewport: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 2, maxItems: 2 },
          wait: { type: "string" },
          max_nodes: { type: "integer", minimum: 1 },
          captured_at: { type: "string" },
          fail_on_error: { type: "boolean" },
        },
      },
      runtime: "node+playwright", determinism: "external", map_over: "group",
    }),
    kind({
      kind: "extract", impl: "ts:extract.dom-node@1.0.0",
      inputs: [port("snapshots", "SnapshotSet"), port("schema", "FeatureSchema")], outputs: [port("features", "NodeFeaturesSet")],
      params_schema: { type: "object", additionalProperties: false },
      runtime: "node", determinism: "pure", map_over: "group",
    }),
    kind({
      kind: "label", impl: "ts:label.heuristic@1.0.0",
      inputs: [port("snapshots", "SnapshotSet"), port("features", "NodeFeaturesSet")], outputs: [port("labels", "NodeLabelsSet")],
      params_schema: {
        type: "object",
        properties: { labeler: { enum: ["readability"] }, confidence: { type: "number", minimum: 0, maximum: 1 } },
        additionalProperties: false,
      },
      runtime: "node", determinism: "pure", map_over: "group",
    }),
    kind({
      kind: "dataset", impl: "ts:dataset.jsonl@1.0.0",
      inputs: [port("features", "NodeFeaturesSet"), port("labels", "NodeLabelsSet"), port("schema", "FeatureSchema"), port("snapshots", "SnapshotSet", { optional: true })],
      outputs: [port("dataset", "Dataset")],
      params_schema: {
        type: "object", required: ["split"],
        properties: {
          split: {
            type: "object", required: ["seed"],
            properties: {
              seed: { type: ["string", "integer"] },
              ranges: { type: "object" },
              overrides: { type: "object", additionalProperties: { enum: ["train", "val", "test"] } },
              group_by: { enum: ["group_key", "group"] },
            },
            additionalProperties: false,
          },
          min_confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        additionalProperties: false,
      },
      runtime: "node", determinism: "pure",
    }),
    kind({
      kind: "train", impl: "rust:train.gp-train@1.0.0",
      inputs: [port("dataset", "Dataset"), port("config", "TrainConfig", { optional: true })], outputs: [port("model", "ModelPackage")],
      params_schema: {
        type: "object", required: ["seed"],
        properties: {
          seed: { type: "integer", minimum: 0, maximum: 4294967295 },
          config: { type: "object" },
          name: { type: "string", minLength: 1 },
          task_name: { type: "string", minLength: 1 },
          created_at: { type: "string" },
        },
        additionalProperties: false,
      },
      runtime: "rust", determinism: "seeded",
    }),
    kind({
      kind: "evaluate", impl: "ts:evaluate.intrinsic@1.0.0",
      inputs: [port("model", "ModelPackage"), port("dataset", "Dataset"), port("baselines", "Bundle", { many: true, optional: true })],
      outputs: [port("report", "EvalReport"), port("extras", "Bundle"), port("details", "Bundle")],
      params_schema: {
        type: "object", required: ["seed"],
        properties: {
          seed: { type: "integer", minimum: 0 },
          split: { enum: ["train", "val", "test", "all"] },
          resamples: { type: "integer", minimum: 100 },
          baselines: { type: "array", items: { type: "string" } },
          gates: { type: "array", items: { type: "object" } },
        },
        additionalProperties: false,
      },
      runtime: "node+wasm", determinism: "seeded",
      gates: [{ id: "params_gates", description: "Every entry of params.gates (metric, comparator, threshold, strata, baseline, CI bound) becomes a gates[] entry of the report." }],
    }),
    kind({
      kind: "package", impl: "ts:package.bundle@1.0.0",
      inputs: [port("model", "ModelPackage")], outputs: [port("bundle", "Bundle")],
      params_schema: { type: "object", additionalProperties: false },
      runtime: "node+wasm", determinism: "pure",
    }),
  ];
}

const ext = (name: string) => ({ external: name });
const out = (stage: string, output: string) => ({ stage, output });

/**
 * The example pipeline: collect -> extract -> label -> dataset -> train -> eval, then package. `package` is LAST in
 * declaration order on purpose (the contract tests address the first six stages by index); the runner orders by dependency.
 */
export function buildPipeline(): PipelineSpec {
  return {
    format: "gran-prix.pipeline-spec",
    format_version: "1.0.0",
    name: "fixture-dom-pipeline",
    description: "Synthetic pipeline used by the contract fixtures. Same shape as pipelines/dom-v0.json, over the real stage implementations.",
    vars: { seed: 42 },
    externals: {
      urls: { type: "UrlList", path: "data/urls.csv" },
      schema: { type: "FeatureSchema", id: sha("feature-schema-id") },
      train_config: { type: "TrainConfig", id: sha("train-config-id") },
    },
    stages: [
      { id: "collect", kind: "collect", impl: "ts:collect.playwright@1.0.0", params: { viewport: [1366, 900], wait: "networkidle+2s" }, inputs: { urls: ext("urls") } },
      { id: "extract", kind: "extract", impl: "ts:extract.dom-node@1.0.0", params: {}, inputs: { snapshots: out("collect", "snapshots"), schema: ext("schema") } },
      { id: "label", kind: "label", impl: "ts:label.heuristic@1.0.0", params: { labeler: "readability", confidence: 0.8 }, inputs: { snapshots: out("collect", "snapshots"), features: out("extract", "features") } },
      {
        id: "dataset", kind: "dataset", impl: "ts:dataset.jsonl@1.0.0",
        params: { split: { seed: "fixture-v1", group_by: "group_key" }, min_confidence: 0.5 },
        inputs: { features: out("extract", "features"), labels: out("label", "labels"), schema: ext("schema"), snapshots: out("collect", "snapshots") },
      },
      {
        id: "train", kind: "train", impl: "rust:train.gp-train@1.0.0", params: { seed: "${vars.seed}" },
        inputs: { dataset: out("dataset", "dataset"), config: ext("train_config") },
      },
      {
        id: "eval", kind: "evaluate", impl: "ts:evaluate.intrinsic@1.0.0", params: { seed: "${vars.seed}", split: "test", gates: [] },
        inputs: { model: out("train", "model"), dataset: out("dataset", "dataset") }, gate: true,
      },
      { id: "package", kind: "package", impl: "ts:package.bundle@1.0.0", params: {}, inputs: { model: out("train", "model") } },
    ],
    layout: { collect: { x: 0, y: 0 }, extract: { x: 200, y: 0 } },
  };
}

/** v1.1: a `demo` stage kind (the runner's own demo stages stop borrowing real kinds). Declared 1.1.0 because it uses `demo`. */
export function buildDemoStageKind(): StageKindSpec {
  return {
    format: "gran-prix.stage-kind-spec",
    format_version: "1.1.0",
    kind: "demo",
    impl: "ts:demo.echo@1.0.0",
    inputs: [port("urls", "UrlList")],
    outputs: [port("echo", "UrlList")],
    params_schema: { type: "object", properties: { message: { type: "string" } } },
    runtime: "node",
    determinism: "pure",
  };
}

export function buildDemoPipeline(): PipelineSpec {
  return {
    format: "gran-prix.pipeline-spec",
    format_version: "1.1.0",
    name: "fixture-demo-pipeline",
    externals: { urls: { type: "UrlList", path: "data/urls.csv" } },
    stages: [{ id: "echo", kind: "demo", impl: "ts:demo.echo@1.0.0", params: { message: "hello" }, inputs: { urls: ext("urls") } }],
  };
}
