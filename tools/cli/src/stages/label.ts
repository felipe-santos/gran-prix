import { canonicalJson, type NodeLabels } from "@gran-prix/contracts";
import {
  NodeFeaturesSetReader,
  SnapshotSetReader,
  assertTruthRules,
  labelPageReadability,
  labelPageTruth,
  mergeLabels,
  readSetDocs,
  type NodeLabelsDoc,
  type PageInput,
  type SetMember,
  type TruthRule,
} from "@gran-prix/labels";
import { defineStage, type StageContext, type StageOutputs, type StagePlugin } from "../stage.js";
import type { ArtifactHandle } from "../store.js";

/**
 * Label stages (E1.7, E2.6). Ports are the canonical ones of the registry: `snapshots` (SnapshotSet) and
 * `features` (NodeFeaturesSet) in, `labels` (NodeLabelsSet) out. SnapshotSet and NodeFeaturesSet are read through
 * the manifest-driven `SnapshotSetReader` / `NodeFeaturesSetReader` the collect and extract stages share
 * (`@gran-prix/labels` `set-readers.ts`); the two are joined by `snapshot_id`. The output set holds one `labels/<snapshot hex12>.json` per snapshot that has feature rows.
 */

const LABELS_FORMAT = "gran-prix.node-labels";

const labelsPath = (doc: { snapshot_id: string }): string => `labels/${doc.snapshot_id.slice("sha256:".length, "sha256:".length + 12)}.json`;

function labelsSet(docs: readonly NodeLabelsDoc[]): StageOutputs {
  const files: Record<string, string> = {};
  for (const d of docs) files[labelsPath(d)] = `${canonicalJson(d)}\n`;
  return { labels: { files } };
}

interface Page extends PageInput {
  name: string;
}

/** Pairs every NodeFeatures with its snapshot and loads the flattened HTML. */
function pages(ctx: StageContext): Page[] {
  const snaps = new SnapshotSetReader(ctx.inputs["snapshots"] as ArtifactHandle);
  const feats = new NodeFeaturesSetReader(ctx.inputs["features"] as ArtifactHandle);
  const entries = new Map(snaps.entries().map((e) => [e.snapshot_id, e]));
  const featureEntries = feats.entries();
  if (featureEntries.length === 0) throw new Error("the features set holds no NodeFeatures document");
  return featureEntries.map((fe) => {
    const se = entries.get(fe.snapshot_id);
    if (!se) throw new Error(`features ${fe.features_id} refer to snapshot ${fe.snapshot_id}, which is not in the snapshot set`);
    const snapshot = snaps.snapshot(se);
    return { name: snapshot.page.url_key, snapshot, features: feats.features(fe), html: snaps.html(se) };
  });
}

const PORTS = {
  inputs: [
    { name: "snapshots", type: "SnapshotSet" },
    { name: "features", type: "NodeFeaturesSet" },
  ],
  outputs: [{ name: "labels", type: "NodeLabelsSet" }],
} as const;

/** `ts:label.heuristic@1.0.0`: heuristic labels; `params.labeler` picks the method (only `readability` exists). */
export const labelHeuristic: StagePlugin = defineStage(
  {
    kind: "label",
    impl: "ts:label.heuristic@1.0.0",
    inputs: [...PORTS.inputs],
    outputs: [...PORTS.outputs],
    params_schema: {
      type: "object",
      properties: {
        labeler: { enum: ["readability"], description: "Heuristic labeler to run." },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "P(label correct) stamped on the labels (default 0.7)." },
        min_coverage: { type: "number", minimum: 0, maximum: 1, description: "Alignment coverage under which a page's labels are discarded (default 0.9)." },
        fuzzy: { type: "boolean", description: "Also keep units rescued by the order-free 2/3 rule (default false)." },
        h1_title: { type: "boolean", description: "Apply the h1-matches-title rule (default true)." },
      },
      additionalProperties: false,
    },
    runtime: "node",
    determinism: "pure",
    map_over: "group",
  },
  (ctx) => {
    const p = ctx.params;
    const docs = pages(ctx).map((page) => {
      const doc = labelPageReadability(page, {
        ...(typeof p["confidence"] === "number" ? { confidence: p["confidence"] } : {}),
        ...(typeof p["min_coverage"] === "number" ? { min_coverage: p["min_coverage"] } : {}),
        ...(typeof p["fuzzy"] === "boolean" ? { fuzzy: p["fuzzy"] } : {}),
        ...(typeof p["h1_title"] === "boolean" ? { h1_title: p["h1_title"] } : {}),
      });
      const a = doc["alignment"] as { discarded: boolean; status: string; coverage: number };
      if (a.discarded) ctx.log(`${page.name}: labels discarded (${a.status}, alignment coverage ${(100 * a.coverage).toFixed(1)}%)`);
      return doc;
    });
    return labelsSet(docs);
  },
);

/**
 * `ts:label.truth@1.0.0`: imports human truth rules (`fixtures/pages/*.truth.json` format) as
 * `label_source: "human"`. The rules are INLINE params, so they are part of the cache key: `pages` maps
 * a snapshot to its rules by `url_contains` (first entry whose string occurs in the page url wins).
 * A snapshot with no entry gets an empty labels document.
 */
export const labelTruth: StagePlugin = defineStage(
  {
    kind: "label",
    impl: "ts:label.truth@1.0.0",
    inputs: [...PORTS.inputs],
    outputs: [...PORTS.outputs],
    params_schema: {
      type: "object",
      required: ["pages"],
      properties: {
        pages: {
          type: "array",
          items: {
            type: "object",
            required: ["url_contains", "rules"],
            properties: {
              url_contains: { type: "string", minLength: 1 },
              rules: {
                type: "array",
                items: {
                  type: "object",
                  required: ["selector", "label"],
                  properties: { selector: { type: "string", minLength: 1 }, label: { enum: ["main", "support", "noise"] } },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "Confidence of the imported labels (default 1)." },
      },
      additionalProperties: false,
    },
    runtime: "node",
    determinism: "pure",
    map_over: "group",
  },
  (ctx) => {
    const entries = ctx.params["pages"] as Array<{ url_contains: string; rules: unknown }>;
    for (const e of entries) assertTruthRules(e.rules);
    const confidence = typeof ctx.params["confidence"] === "number" ? ctx.params["confidence"] : undefined;
    const docs = pages(ctx).map((page) => {
      const urls = [page.snapshot.page.url, page.snapshot.page.final_url];
      const entry = entries.find((e) => urls.some((u) => u.includes(e.url_contains)));
      if (!entry) ctx.log(`${page.name}: no truth rules for this page, empty labels`);
      const doc = labelPageTruth(page, entry ? (entry.rules as TruthRule[]) : null, confidence === undefined ? {} : { confidence });
      const t = doc["truth_import"] as { uncovered_candidates?: number } | undefined;
      if (t?.uncovered_candidates) ctx.log(`${page.name}: ${t.uncovered_candidates} text elements are not covered by any rule`);
      return doc;
    });
    return labelsSet(docs);
  },
);

/**
 * `ts:label.merge@1.0.0`: merges layers of labels per snapshot with the fixed precedence
 * human > user_feedback > llm > readability > heuristic > rule. Layer order only breaks exact ties.
 * A snapshot labeled by a single layer passes through unchanged.
 */
export const labelMerge: StagePlugin = defineStage(
  {
    kind: "label",
    impl: "ts:label.merge@1.0.0",
    inputs: [{ name: "layers", type: "NodeLabelsSet", many: true }],
    outputs: [...PORTS.outputs],
    params_schema: { type: "object", additionalProperties: false },
    runtime: "node",
    determinism: "pure",
  },
  (ctx) => {
    const bySnapshot = new Map<string, NodeLabels[]>();
    for (const layer of ctx.inputs["layers"] as ArtifactHandle[]) {
      for (const m of readSetDocs<NodeLabels>(layer, LABELS_FORMAT) as SetMember<NodeLabels>[]) {
        const list = bySnapshot.get(m.doc.snapshot_id);
        if (list) list.push(m.doc);
        else bySnapshot.set(m.doc.snapshot_id, [m.doc]);
      }
    }
    const docs = [...bySnapshot.values()].map((list) => (list.length === 1 ? (list[0] as NodeLabelsDoc) : mergeLabels(list)));
    return labelsSet(docs);
  },
);

export const LABEL_STAGES: readonly StagePlugin[] = [labelHeuristic, labelTruth, labelMerge];
