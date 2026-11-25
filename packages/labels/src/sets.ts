import { gunzipSync } from "node:zlib";
import { sha256Of, type FileRef } from "@gran-prix/contracts";

/**
 * Reading the "Set" artifacts the stages pass around (SnapshotSet, NodeFeaturesSet, NodeLabelsSet).
 *
 * Convention (the registry only names the types): a Set is a file-set artifact whose members are JSON
 * files, one contract document each, at any path. A member is recognized by its `format` field, and
 * members of different sets are joined by `snapshot_id`, never by file name. A Set stored as a JSON
 * artifact (one document, or an array of documents) is accepted as well. The HTML of a snapshot is the
 * gzip (or plain file) its `html` FileRef points to; the path is resolved next to the snapshot file
 * first, then from the root of the set.
 */

/** What both an `ArtifactHandle` and a plain in-memory set offer. */
export interface FileSetLike {
  files(): string[];
  file(path: string): Uint8Array;
}

/** An `ArtifactHandle`: files for a file-set artifact, `json()` for a JSON artifact. */
export interface SetSource extends FileSetLike {
  json(): unknown;
}

export interface SetMember<T> {
  /** Path of the member inside the set ("" for a JSON artifact). */
  path: string;
  doc: T;
}

const decoder = new TextDecoder();

export function readSetDocs<T>(source: SetSource, format: string): SetMember<T>[] {
  const out: SetMember<T>[] = [];
  const paths = source.files();
  if (paths.length > 0) {
    for (const p of [...paths].sort()) {
      if (!p.endsWith(".json")) continue;
      let doc: unknown;
      try {
        doc = JSON.parse(decoder.decode(source.file(p)));
      } catch {
        continue; // not a JSON document: a sibling file of the member (e.g. a manifest of the collector)
      }
      if (isDoc(doc, format)) out.push({ path: p, doc: doc as T });
    }
    return out;
  }
  let j: unknown;
  try {
    j = source.json();
  } catch {
    return out; // an empty file set: no members
  }
  for (const d of Array.isArray(j) ? j : [j]) if (isDoc(d, format)) out.push({ path: "", doc: d as T });
  return out;
}

function isDoc(v: unknown, format: string): boolean {
  return typeof v === "object" && v !== null && (v as { format?: unknown }).format === format;
}

const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (dir: string, p: string): string => (dir === "" ? p : `${dir}/${p}`);

/**
 * Loads the HTML a snapshot points to. Accepts a gzip or a plain file; the FileRef hash may be of the
 * stored bytes or of the decoded HTML, and a mismatch with both is an integrity error.
 */
export function loadSnapshotHtml(set: FileSetLike, memberPath: string, ref: FileRef): string {
  const all = new Set(set.files());
  const candidates = [join(dirOf(memberPath), ref.path), ref.path].filter((p) => all.has(p));
  const path = candidates[0];
  if (path === undefined) {
    throw new Error(`snapshot html "${ref.path}" (referenced by "${memberPath}") is not in the SnapshotSet`);
  }
  const bytes = set.file(path);
  const gz = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const decoded = gz ? new Uint8Array(gunzipSync(bytes)) : bytes;
  if (sha256Of(bytes) !== ref.sha256 && sha256Of(decoded) !== ref.sha256) {
    throw new Error(`snapshot html "${path}" does not match its FileRef sha256 ${ref.sha256}`);
  }
  return decoder.decode(decoded);
}
