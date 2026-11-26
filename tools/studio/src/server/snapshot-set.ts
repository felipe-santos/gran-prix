import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validate, type NodeLabels, type PageSnapshot } from "@gran-prix/contracts";
import { SnapshotSetReader, hexOf, type SnapshotSetEntry } from "@gran-prix/labels";

/**
 * Read access to the artifact store of a `gp` data dir (`<data>/artifacts/sha256-<hex>/{meta.json,files/...}`),
 * restricted to what the Studio needs: SnapshotSets (pages) and NodeLabelsSets (drafts).
 *
 * The SnapshotSet layout (`manifest.json`, `snapshots/<hex>.json`, `html/<hex>.html.gz`) is read with the shared
 * `SnapshotSetReader` (defined in `@gran-prix/labels`, which the Studio already depends on, and re-exported by
 * `@gran-prix/cli`: it is the very same class). The reader takes a `FileSource`; here that is a directory of the store,
 * with every path checked by `safeRel`. Importing the cli itself would drag every stage, the trainer included, into a
 * labeling tool, and the cli must not depend on the Studio.
 */

export type { SnapshotSetEntry };
export { hexOf };

export interface PageRef {
  hex: string;
  entry: SnapshotSetEntry;
  /** Directory `files/` of the SnapshotSet artifact that holds the page. */
  filesDir: string;
  /** Reader of the SnapshotSet artifact that holds the page. */
  reader: SnapshotSetReader;
}

const HEX_RE = /^[0-9a-f]{64}$/;

export const isHex = (v: string): boolean => HEX_RE.test(v);

/** An artifact-relative path from a manifest: relative, '/'-separated, no empty, '.' or '..' segments. */
export function safeRel(p: unknown): string {
  if (typeof p !== "string" || p === "" || p.startsWith("/") || p.includes("\\") || p.includes("\0")) throw new Error(`unsafe artifact path ${JSON.stringify(p)}`);
  if (p.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error(`unsafe artifact path ${JSON.stringify(p)}`);
  return p;
}

interface StoredArtifact {
  type: string;
  filesDir: string;
}

/** Artifacts of the store, optionally of one type. A missing store is an empty one. */
export function listArtifacts(dataDir: string, type: string): StoredArtifact[] {
  const root = join(dataDir, "artifacts");
  if (!existsSync(root)) return [];
  const out: StoredArtifact[] = [];
  for (const name of readdirSync(root).sort()) {
    if (!name.startsWith("sha256-")) continue; // temp dirs of a running writer
    try {
      const meta = JSON.parse(readFileSync(join(root, name, "meta.json"), "utf8")) as { kind?: string; type?: string };
      if (meta.kind === "files" && meta.type === type) out.push({ type, filesDir: join(root, name, "files") });
    } catch {
      /* half-written or foreign directory: not an artifact */
    }
  }
  return out;
}

/** Every page of every SnapshotSet of the data dir (a snapshot present in several sets appears once, first set wins). */
export function listPages(dataDir: string): PageRef[] {
  const seen = new Set<string>();
  const out: PageRef[] = [];
  for (const art of listArtifacts(dataDir, "SnapshotSet")) {
    const reader = new SnapshotSetReader({ file: (p) => readFileSync(join(art.filesDir, safeRel(p))) });
    let entries: SnapshotSetEntry[];
    try {
      entries = reader.entries();
    } catch {
      continue; // no manifest, not a SnapshotSet manifest
    }
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry.snapshot_id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(entry.snapshot_id)) continue;
      const hex = hexOf(entry.snapshot_id);
      if (seen.has(hex)) continue;
      seen.add(hex);
      out.push({ hex, entry, filesDir: art.filesDir, reader });
    }
  }
  return out;
}

/** The contract-valid PageSnapshot of a page; throws when it does not validate (id recomputation included). */
export function readSnapshot(ref: PageRef): PageSnapshot {
  const doc: unknown = ref.reader.snapshot(ref.entry);
  const r = validate("page-snapshot", doc);
  if (!r.ok) throw new Error(`snapshot ${ref.hex.slice(0, 12)} is not a valid PageSnapshot: ${r.issues.map((i) => `${i.path}: ${i.message}`).slice(0, 3).join("; ")}`);
  return r.value;
}

/** The flattened html of a page, decoded. */
export function readHtml(ref: PageRef): string {
  return ref.reader.html(ref.entry);
}

/** NodeLabels documents found in NodeLabelsSet artifacts of the store, by snapshot id. */
export function listLabelDocs(dataDir: string): Map<string, NodeLabels[]> {
  const out = new Map<string, NodeLabels[]>();
  for (const art of listArtifacts(dataDir, "NodeLabelsSet")) {
    for (const rel of walkJson(art.filesDir, "")) {
      try {
        const doc = JSON.parse(readFileSync(join(art.filesDir, rel), "utf8")) as NodeLabels;
        if (doc.format !== "gran-prix.node-labels") continue;
        const list = out.get(doc.snapshot_id) ?? [];
        list.push(doc);
        out.set(doc.snapshot_id, list);
      } catch {
        /* not a labels document */
      }
    }
  }
  return out;
}

function walkJson(root: string, rel: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...walkJson(root, p));
    else if (e.name.endsWith(".json")) out.push(p);
  }
  return out;
}
