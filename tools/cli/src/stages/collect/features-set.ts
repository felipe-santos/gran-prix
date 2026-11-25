import type { NodeFeatures } from "@gran-prix/contracts";
import type { FileSource } from "./snapshot-set.js";
import { hexOf } from "./snapshot-set.js";

/**
 * Layout of a `NodeFeaturesSet` artifact (file-set artifact, port not `many`):
 *
 *   manifest.json                    NodeFeaturesSetManifest: one entry per snapshot, in SnapshotSet order
 *   features/<hex>.json              one contract-valid NodeFeatures per snapshot (<hex> = its snapshot_id without "sha256:")
 *
 * The manifest repeats `group_key` / `stratum` / `flags` of the snapshot so the dataset stage can split
 * and filter without opening the snapshots.
 */
export const FEATURES_SET_FORMAT = "gran-prix.node-features-set" as const;

export interface NodeFeaturesSetEntry {
  snapshot_id: string;
  features_id: string;
  group_key: string;
  stratum: string;
  flags: string[];
  /** Rows of `x` (nodes that survived the prefilter). */
  n_rows: number;
  /** Artifact-relative path of the NodeFeatures JSON. */
  features: string;
}

export interface NodeFeaturesSetManifest {
  format: typeof FEATURES_SET_FORMAT;
  format_version: "1.0.0";
  feature_schema_id: string;
  entries: NodeFeaturesSetEntry[];
}

export const featuresPath = (snapshotId: string): string => `features/${hexOf(snapshotId)}.json`;

const decoder = new TextDecoder();

/** Typed access to a stored `NodeFeaturesSet`. */
export class NodeFeaturesSetReader {
  constructor(private readonly source: FileSource) {}

  manifest(): NodeFeaturesSetManifest {
    const m = JSON.parse(decoder.decode(this.source.file("manifest.json"))) as NodeFeaturesSetManifest;
    if (m.format !== FEATURES_SET_FORMAT) throw new Error(`not a NodeFeaturesSet: manifest.format is ${JSON.stringify(m.format)}`);
    return m;
  }

  entries(): NodeFeaturesSetEntry[] {
    return this.manifest().entries;
  }

  features(entry: Pick<NodeFeaturesSetEntry, "features">): NodeFeatures {
    return JSON.parse(decoder.decode(this.source.file(entry.features))) as NodeFeatures;
  }
}
