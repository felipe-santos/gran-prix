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

/** Registry matching `buildPipeline()`. */
export function buildStageKinds(): StageKindSpec[] {
  return [
    kind({
      kind: "collect", impl: "ts:collect.playwright@1.0.0",
      inputs: [port("urls", "UrlList")], outputs: [port("snapshots", "SnapshotSet")],
      params_schema: {
        type: "object", required: ["viewport"],
        properties: { viewport: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 }, wait: { type: "string" }, max_nodes: { type: "integer", minimum: 1 } },
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
      params_schema: { type: "object", properties: { confidence: { type: "number", minimum: 0, maximum: 1 } } },
      runtime: "node", determinism: "pure", map_over: "group",
    }),
    kind({
      kind: "dataset", impl: "ts:dataset.jsonl@1.0.0",
      inputs: [port("features", "NodeFeaturesSet"), port("labels", "NodeLabelsSet"), port("schema", "FeatureSchema")], outputs: [port("dataset", "Dataset")],
      params_schema: { type: "object", required: ["split"], properties: { split: { type: "object" }, min_confidence: { type: "number" } } },
      runtime: "node", determinism: "pure",
    }),
    kind({
      kind: "train", impl: "ts:train.wasm-trainer@1.0.0",
      inputs: [port("dataset", "Dataset")], outputs: [port("model", "ModelPackage")],
      params_schema: { type: "object", required: ["seed"], properties: { seed: { type: "integer", minimum: 0 }, epochs: { type: "integer", minimum: 1 } } },
      runtime: "node+wasm", determinism: "seeded",
    }),
    kind({
      kind: "evaluate", impl: "ts:evaluate.intrinsic@1.0.0",
      inputs: [port("model", "ModelPackage"), port("dataset", "Dataset")], outputs: [port("report", "EvalReport")],
      params_schema: { type: "object", properties: { split: { enum: ["train", "val", "test", "all"] }, baselines: { type: "array", items: { type: "string" } } } },
      runtime: "node+wasm", determinism: "pure",
      gates: [{ id: "f1_vs_baseline", description: "Macro F1 delta against the baseline is >= 0." }],
    }),
  ];
}

const ext = (name: string) => ({ external: name });
const out = (stage: string, output: string) => ({ stage, output });

export function buildPipeline(): PipelineSpec {
  return {
    format: "gran-prix.pipeline-spec",
    format_version: "1.0.0",
    name: "fixture-dom-pipeline",
    description: "Synthetic pipeline used by the contract fixtures.",
    vars: { seed: 42 },
    externals: {
      urls: { type: "UrlList", path: "data/urls.csv" },
      schema: { type: "FeatureSchema", id: sha("feature-schema-id") },
    },
    stages: [
      { id: "collect", kind: "collect", impl: "ts:collect.playwright@1.0.0", params: { viewport: [1366, 900], wait: "networkidle+2s" }, inputs: { urls: ext("urls") } },
      { id: "extract", kind: "extract", impl: "ts:extract.dom-node@1.0.0", params: {}, inputs: { snapshots: out("collect", "snapshots"), schema: ext("schema") } },
      { id: "label", kind: "label", impl: "ts:label.heuristic@1.0.0", params: { confidence: 0.8 }, inputs: { snapshots: out("collect", "snapshots"), features: out("extract", "features") } },
      {
        id: "dataset", kind: "dataset", impl: "ts:dataset.jsonl@1.0.0",
        params: { split: { group_by: "group_key", salt: "fixture-v1" }, min_confidence: 0.5 },
        inputs: { features: out("extract", "features"), labels: out("label", "labels"), schema: ext("schema") },
      },
      { id: "train", kind: "train", impl: "ts:train.wasm-trainer@1.0.0", params: { seed: "${vars.seed}", epochs: 30 }, inputs: { dataset: out("dataset", "dataset") } },
      {
        id: "eval", kind: "evaluate", impl: "ts:evaluate.intrinsic@1.0.0", params: { split: "test", baselines: ["readability"] },
        inputs: { model: out("train", "model"), dataset: out("dataset", "dataset") }, gate: true,
      },
    ],
    layout: { collect: { x: 0, y: 0 }, extract: { x: 200, y: 0 } },
  };
}
