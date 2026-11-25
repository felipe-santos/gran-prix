import { canonicalJson, validate, type FeatureSchema, type NodeFeatures } from "@gran-prix/contracts";
import type { FeatureSchemaLike } from "@gran-prix/features";
import { defineStage } from "../stage.js";
import type { ArtifactHandle } from "../store.js";
import {
  FEATURES_SET_FORMAT,
  featuresPath,
  type NodeFeaturesSetEntry,
  type NodeFeaturesSetManifest,
} from "./collect/features-set.js";
import { SnapshotSetReader } from "./collect/snapshot-set.js";

/**
 * `ts:extract.dom-node@1.0.0`: SnapshotSet + FeatureSchema -> NodeFeaturesSet.
 *
 * Applies the pure `vectorize` of @gran-prix/features to every snapshot. A function of its two inputs
 * only (no clock, no randomness, no browser), so the same inputs give the same artifact id. Every
 * NodeFeatures is checked against the contract before it is written. Layout of the output: see
 * `collect/features-set.ts`.
 *
 * Not `map_over` aware yet: the runner caches per stage, so adding one page re-extracts all of them
 * (the vectorizer takes milliseconds per page; the collect stage is what is expensive).
 */
export const extract = defineStage(
  {
    kind: "extract",
    impl: "ts:extract.dom-node@1.0.0",
    inputs: [
      { name: "snapshots", type: "SnapshotSet" },
      { name: "schema", type: "FeatureSchema" },
    ],
    outputs: [{ name: "features", type: "NodeFeaturesSet" }],
    params_schema: { type: "object", additionalProperties: false },
    runtime: "node",
    determinism: "pure",
    map_over: "group",
  },
  async (ctx) => {
    // Loaded on demand: the package root also exports the Playwright driver, which `gp validate` never needs.
    const { vectorize } = await import("@gran-prix/features");
    const schemaDoc = (ctx.inputs["schema"] as ArtifactHandle).json();
    const schemaCheck = validate("feature-schema", schemaDoc);
    if (!schemaCheck.ok) {
      const first = schemaCheck.issues[0];
      throw new Error(`extract: the schema input is not a valid FeatureSchema: ${first ? `${first.path}: ${first.message}` : "?"}`);
    }
    const schema: FeatureSchema = schemaCheck.value;

    const set = new SnapshotSetReader(ctx.inputs["snapshots"] as ArtifactHandle);
    const files: Record<string, string> = {};
    const entries: NodeFeaturesSetEntry[] = [];
    for (const entry of set.entries()) {
      const snapshot = set.snapshot(entry);
      if (snapshot.snapshot_id !== entry.snapshot_id) throw new Error(`extract: ${entry.snapshot} holds ${snapshot.snapshot_id}, the manifest says ${entry.snapshot_id}`);
      const doc = vectorize(snapshot, schema as unknown as FeatureSchemaLike) as unknown as NodeFeatures;
      const checked = validate("node-features", doc);
      if (!checked.ok) {
        const first = checked.issues[0];
        throw new Error(`extract: NodeFeatures of ${entry.url} is not contract-valid: ${first ? `${first.path}: ${first.message}` : "?"}`);
      }
      const path = featuresPath(entry.snapshot_id);
      files[path] = `${canonicalJson(doc)}\n`;
      entries.push({
        snapshot_id: entry.snapshot_id,
        features_id: doc.features_id,
        group_key: entry.group_key,
        stratum: entry.stratum,
        flags: entry.flags,
        n_rows: doc.unit_ids.length,
        features: path,
      });
    }
    const manifest: NodeFeaturesSetManifest = { format: FEATURES_SET_FORMAT, format_version: "1.0.0", feature_schema_id: schema.schema_id, entries };
    files["manifest.json"] = `${canonicalJson(manifest)}\n`;
    ctx.log(`${entries.length} snapshot(s) x ${schema.dim} features (${schema.schema_id.slice(0, 15)})`);
    return { features: { files } };
  },
);
