import { gunzipSync } from "node:zlib";
import type { PageSnapshot } from "@gran-prix/contracts";
import type { ArtifactHandle } from "../../store.js";
import type { PageFlag } from "./flags.js";

/**
 * Layout of a `SnapshotSet` artifact (a file-set artifact; ports of this type are not `many`):
 *
 *   manifest.json                    SnapshotSetManifest: entries in UrlList order, plus the failures
 *   snapshots/<hex>.json             one contract-valid PageSnapshot per page (<hex> = snapshot_id without "sha256:")
 *   html/<hex>.html.gz               the flattened rendered HTML of that page (see FLATTEN_SOURCE), gzip;
 *                                    <hex> = sha256 of the DECODED html, so the path is part of the snapshot id without
 *                                    depending on it (identical pages share one file)
 *
 * `snapshot.html.path` is the artifact-relative path of the gz file ("html/<hex>.html.gz").
 */
export const SNAPSHOT_SET_FORMAT = "gran-prix.snapshot-set" as const;

export interface SnapshotSetEntry {
  snapshot_id: string;
  url: string;
  final_url: string;
  stratum: string;
  group_key: string;
  http_status: number;
  flags: PageFlag[];
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

export const hexOf = (id: string): string => id.replace(/^sha256:/, "");
export const snapshotPath = (id: string): string => `snapshots/${hexOf(id)}.json`;
export const htmlPath = (htmlSha256: string): string => `html/${hexOf(htmlSha256)}.html.gz`;

/** The part of an artifact handle the readers need (also satisfied by the store handle). */
export type FileSource = Pick<ArtifactHandle, "file">;

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
