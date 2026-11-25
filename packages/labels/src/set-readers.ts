import { gunzipSync } from "node:zlib";
import type { NodeFeatures, PageSnapshot } from "@gran-prix/contracts";

/**
 * Readers (and the on-disk layout) of the two "Set" artifacts the collect and extract stages write and
 * the label and dataset stages read. They live here, in the package every consumer already depends on,
 * so the collect stage (`tools/cli`) and the labelers share ONE definition without a dependency cycle
 * (`@gran-prix/cli` imports `@gran-prix/labels`, never the reverse). The readers are strict: they follow
 * `manifest.json`, check its `format`, and do not guess a layout.
 *
 * SnapshotSet (file-set artifact; ports of this type are not `many`):
 *
 *   manifest.json                    SnapshotSetManifest: entries in UrlList order, plus the failures
 *   snapshots/<hex>.json             one contract-valid PageSnapshot per page (<hex> = snapshot_id without "sha256:")
 *   html/<hex>.html.gz               the flattened rendered HTML of that page, gzip; <hex> = sha256 of the
 *                                    DECODED html, so the path is part of the snapshot id without depending
 *                                    on it (identical pages share one file)
 *
 * NodeFeaturesSet (file-set artifact):
 *
 *   manifest.json                    NodeFeaturesSetManifest: one entry per snapshot, in SnapshotSet order
 *   features/<hex>.json              one contract-valid NodeFeatures per snapshot (<hex> = its snapshot_id)
 *
 * The features manifest repeats `group_key` / `stratum` / `flags` of the snapshot so the dataset stage can
 * split and filter without opening the snapshots.
 */
export const SNAPSHOT_SET_FORMAT = "gran-prix.snapshot-set" as const;
export const FEATURES_SET_FORMAT = "gran-prix.node-features-set" as const;

export interface SnapshotSetEntry {
  snapshot_id: string;
  url: string;
  final_url: string;
  stratum: string;
  group_key: string;
  http_status: number;
  /** Capture flags (`http-error`, `error-page`, `captcha`, `paywall`, `tiny-dom`). */
  flags: string[];
  node_count: number;
  /** Artifact-relative path of the PageSnapshot JSON. */
  snapshot: string;
  /** Artifact-relative path of the gzipped flattened html. */
  html: string;
}

export interface SnapshotSetFailure {
  url: string;
  stratum: string;
  reason: "navigation" | "capture" | "max_nodes" | "bad_url";
  message: string;
}

export interface SnapshotSetManifest {
  format: typeof SNAPSHOT_SET_FORMAT;
  format_version: "1.0.0";
  entries: SnapshotSetEntry[];
  /** Pages that could not become a snapshot. Never silent: the stage logs them and `fail_on_error` can abort. */
  failures: SnapshotSetFailure[];
}

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

export const hexOf = (id: string): string => id.replace(/^sha256:/, "");
export const snapshotPath = (id: string): string => `snapshots/${hexOf(id)}.json`;
export const htmlPath = (htmlSha256: string): string => `html/${hexOf(htmlSha256)}.html.gz`;
export const featuresPath = (snapshotId: string): string => `features/${hexOf(snapshotId)}.json`;

/** The part of an artifact handle the readers need (an `ArtifactHandle` of the store satisfies it). */
export interface FileSource {
  file(path: string): Uint8Array;
}

const decoder = new TextDecoder();

/** Typed access to a stored `SnapshotSet` (collect writes it; extract, label and dataset read it). */
export class SnapshotSetReader {
  constructor(private readonly source: FileSource) {}

  manifest(): SnapshotSetManifest {
    const m = JSON.parse(decoder.decode(this.source.file("manifest.json"))) as SnapshotSetManifest;
    if (m.format !== SNAPSHOT_SET_FORMAT) throw new Error(`not a SnapshotSet: manifest.format is ${JSON.stringify(m.format)}`);
    return m;
  }

  entries(): SnapshotSetEntry[] {
    return this.manifest().entries;
  }

  snapshot(entry: Pick<SnapshotSetEntry, "snapshot">): PageSnapshot {
    return JSON.parse(decoder.decode(this.source.file(entry.snapshot))) as PageSnapshot;
  }

  /** The flattened html, decoded. */
  html(entry: Pick<SnapshotSetEntry, "html">): string {
    return decoder.decode(gunzipSync(this.source.file(entry.html)));
  }
}

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
