/**
 * Reading a `NodeLabelsSet`, the one Set that has no manifest: a file-set artifact whose JSON members
 * (`labels/<snapshot hex12>.json`) are recognized by their `format` field and joined to pages by `snapshot_id`,
 * never by file name. A set stored as a JSON artifact (one document, or an array of documents) is accepted as
 * well. SnapshotSet and NodeFeaturesSet are manifest-driven and have strict readers in `set-readers.ts`.
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

/** Members by `snapshot_id`; two members for one snapshot is an error (merge labels of a snapshot first). */
export function indexBySnapshot<T extends { snapshot_id: string }>(members: readonly SetMember<T>[], what: string): Map<string, SetMember<T>> {
  const out = new Map<string, SetMember<T>>();
  for (const m of members) {
    if (out.has(m.doc.snapshot_id)) throw new Error(`two ${what} documents for snapshot ${m.doc.snapshot_id}`);
    out.set(m.doc.snapshot_id, m);
  }
  return out;
}
