import { LABEL_SOURCES, type FeatureSchema, type LabelSource, type NodeFeatures, type NodeLabels, type PageSnapshot, type SplitName, type SplitRanges } from "@gran-prix/contracts";
import { buildDataset, indexBySnapshot, readSetDocs, type DatasetSource } from "@gran-prix/labels";
import { defineStage, type StagePlugin } from "../stage.js";
import type { ArtifactHandle } from "../store.js";

/**
 * `ts:dataset.jsonl@1.0.0` (E1.7): features + labels + feature schema -> Dataset (manifest.json plus
 * train/val/test JSONL). Canonical ports of the registry, plus an OPTIONAL `snapshots` input that
 * supplies each page's `group_key` (the domain the split must not cut) and `category` (stratum):
 * NodeFeatures and NodeLabels carry neither. Without it the stage fails with a message saying so.
 *
 * Split: `hash-bucket-v1` over `group_key` with `params.split.seed` as the salt; no PRNG, so adding
 * pages never moves an existing domain. The test split only takes `test_allowed_sources` (human by
 * default, ADR-006). Pages flagged at capture (http-error, error-page, captcha, paywall, tiny-dom) are
 * excluded by default and listed in `excluded_pages` of the manifest. Projection to binary: `keep_classes` (default main + support), written to the manifest.
 */

const SPLIT_NAMES = ["train", "val", "test"] as const satisfies readonly SplitName[];
const rangeSchema = { type: "array", items: { type: "integer", minimum: 0, maximum: 100 }, minItems: 2, maxItems: 2 };
const sourcesSchema = { type: "array", items: { enum: [...LABEL_SOURCES] }, uniqueItems: true };

export const datasetJsonl: StagePlugin = defineStage(
  {
    kind: "dataset",
    impl: "ts:dataset.jsonl@1.0.0",
    inputs: [
      { name: "features", type: "NodeFeaturesSet" },
      { name: "labels", type: "NodeLabelsSet" },
      { name: "schema", type: "FeatureSchema" },
      { name: "snapshots", type: "SnapshotSet", optional: true },
    ],
    outputs: [{ name: "dataset", type: "Dataset" }],
    params_schema: {
      type: "object",
      required: ["split"],
      properties: {
        split: {
          type: "object",
          required: ["seed"],
          properties: {
            seed: { type: ["string", "integer"], description: "Salt of the hash bucket (a number is used as its decimal string)." },
            ranges: {
              type: "object",
              required: [...SPLIT_NAMES],
              properties: { train: rangeSchema, val: rangeSchema, test: rangeSchema },
              additionalProperties: false,
              description: "Half-open bucket ranges over 100 buckets that tile [0, 100). Default train [0,70) val [70,85) test [85,100).",
            },
            overrides: { type: "object", additionalProperties: { enum: [...SPLIT_NAMES] }, description: "group_key -> split, wins over the hash." },
            group_by: { enum: ["group_key", "group"], description: "What the split hashes: the domain (default) or the page." },
          },
          additionalProperties: false,
        },
        min_confidence: { type: "number", minimum: 0, maximum: 1 },
        allowed_sources: sourcesSchema,
        test_allowed_sources: { ...sourcesSchema, description: "Label sources accepted in the test split. Default [\"human\"] (ADR-006)." },
        keep_classes: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, description: "Classes projected to keep. Default main + support." },
        dedupe: { enum: ["none", "exact_x_per_group"] },
        exclude_flags: {
          type: "array",
          items: { type: "string", minLength: 1 },
          uniqueItems: true,
          description:
            "Pages whose capture.flags include one of these are left out and listed in the manifest (excluded_pages). Default: http-error, error-page, captcha, paywall, tiny-dom; [] keeps every page.",
        },
      },
      additionalProperties: false,
    },
    runtime: "node",
    determinism: "pure",
  },
  (ctx) => {
    const p = ctx.params;
    const split = p["split"] as {
      seed: string | number;
      ranges?: Record<SplitName, [number, number]>;
      overrides?: Record<string, SplitName>;
      group_by?: "group_key" | "group";
    };
    const schema = (ctx.inputs["schema"] as ArtifactHandle).json() as FeatureSchema;
    const features = indexBySnapshot(readSetDocs<NodeFeatures>(ctx.inputs["features"] as ArtifactHandle, "gran-prix.node-features"), "NodeFeatures");
    const labels = indexBySnapshot(readSetDocs<NodeLabels>(ctx.inputs["labels"] as ArtifactHandle, "gran-prix.node-labels"), "NodeLabels");
    const snapsInput = ctx.inputs["snapshots"] as ArtifactHandle | undefined;
    if (!snapsInput) {
      throw new Error('dataset needs each page\'s group_key and category to split by domain: connect the "snapshots" input');
    }
    const snapshots = indexBySnapshot(readSetDocs<PageSnapshot>(snapsInput, "gran-prix.page-snapshot"), "PageSnapshot");

    const sources: DatasetSource[] = [];
    for (const [id, f] of features) {
      const l = labels.get(id);
      const s = snapshots.get(id);
      if (!l) {
        ctx.log(`snapshot ${id}: features without labels, left out of the dataset`);
        continue;
      }
      if (!s) throw new Error(`features ${f.doc.features_id} refer to snapshot ${id}, which is not in the snapshot set`);
      sources.push({
        page: { snapshot_id: s.doc.snapshot_id, group_key: s.doc.page.group_key, category: s.doc.page.category, flags: captureFlags(s.doc) },
        features: f.doc,
        labels: l.doc,
      });
    }
    for (const id of labels.keys()) if (!features.has(id)) ctx.log(`snapshot ${id}: labels without features, left out of the dataset`);

    const built = buildDataset(schema, sources, {
      seed: split.seed,
      ...(split.ranges ? { ranges: split.ranges as SplitRanges } : {}),
      ...(split.overrides ? { overrides: split.overrides } : {}),
      ...(split.group_by ? { group_by: split.group_by } : {}),
      ...(typeof p["min_confidence"] === "number" ? { min_confidence: p["min_confidence"] } : {}),
      ...(Array.isArray(p["allowed_sources"]) ? { allowed_sources: p["allowed_sources"] as LabelSource[] } : {}),
      ...(Array.isArray(p["test_allowed_sources"]) ? { test_allowed_sources: p["test_allowed_sources"] as LabelSource[] } : {}),
      ...(Array.isArray(p["keep_classes"]) ? { keep_classes: p["keep_classes"] as string[] } : {}),
      ...(Array.isArray(p["exclude_flags"]) ? { exclude_flags: p["exclude_flags"] as string[] } : {}),
      ...(p["dedupe"] === "none" || p["dedupe"] === "exact_x_per_group" ? { dedupe: p["dedupe"] } : {}),
    });
    const orphans = Object.values(built.orphan_labels).reduce((a, b) => a + b, 0);
    if (orphans > 0) ctx.log(`${orphans} labels point at units that are not feature rows and were left out`);
    const m = built.manifest;
    ctx.log(
      `dataset ${m.dataset_id.slice(0, 19)}: ${m.groups.length} pages, rows train ${m.files.train.rows} / val ${m.files.val.rows} / test ${m.files.test.rows}`,
    );
    return { dataset: { files: built.files } };
  },
);

/** `capture.flags` of a snapshot (extension of the contract, written by the collect stage). */
function captureFlags(snapshot: PageSnapshot): string[] {
  const f = (snapshot.capture as { flags?: unknown }).flags;
  return Array.isArray(f) ? f.filter((x): x is string => typeof x === "string") : [];
}

export const DATASET_STAGES: readonly StagePlugin[] = [datasetJsonl];
