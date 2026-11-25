import { DEFAULT_KEEP_CLASSES, assertValid, projectToBinary, type NodeLabels } from "@gran-prix/contracts";
import type { StageContext } from "../../stage.js";
import type { ArtifactHandle } from "../../store.js";

/**
 * The systems whose output is measured: each says, per page, which units (element idx) it keeps. Two input forms,
 * the same two the evaluate stage accepts (read here on purpose, not imported from it: that stage belongs to another lane):
 *  - `systems` (NodeLabelsSet, many): one NodeLabels document per page; keep = the label classes in `keep_classes`
 *    (default main + support; a binary label space keeps y = 1). A unit the document does not label is NOT kept.
 *  - `predictions` (Bundle, many): `{ id, threshold?, predictions: [{ g, u, p }] }` as JSON, or a file set with
 *    `predictions.jsonl` (+ optional `system.json`). `p` is 0/1 or a score in [0, 1] compared with `threshold`
 *    (default 0.5). `g` is the dataset group id `<group_key>#<snapshot hex12>`: the page is found by the hex12 suffix.
 * A page that a system has no document or prediction for is NOT covered: its output is empty (no credit).
 */

export interface KeepSystem {
  id: string;
  /** Where the keeps come from, for the notes. */
  origin: string;
  /** Kept unit idxs of a snapshot (hex12 = the 12 first hex digits of its id); null = the system does not cover the page. */
  keepOf(snapshotId: string): Set<number> | null;
}

const dec = new TextDecoder();
const NODE_LABELS = "gran-prix.node-labels";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isLabels = (v: unknown): v is NodeLabels => isRecord(v) && v["format"] === NODE_LABELS;
const hex12 = (snapshotId: string): string => snapshotId.slice("sha256:".length, "sha256:".length + 12);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const handlesOf = (ctx: StageContext, port: string): ArtifactHandle[] => {
  const v = ctx.inputs[port];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
};

/** The NodeLabels documents of an artifact: the `.json` members of a file set, or the document(s) of a JSON artifact. */
function labelDocs(h: ArtifactHandle): NodeLabels[] {
  const docs: unknown[] = [];
  if (h.files().length > 0) {
    for (const f of [...h.files()].sort()) {
      if (!f.endsWith(".json")) continue;
      try {
        docs.push(JSON.parse(dec.decode(h.file(f))));
      } catch {
        // a sibling file that is not a document
      }
    }
  } else {
    try {
      const j = h.json();
      docs.push(...(Array.isArray(j) ? j : [j]));
    } catch {
      // empty
    }
  }
  return docs.filter(isLabels).map((d) => assertValid("node-labels", d));
}

function labelsSystem(docs: readonly NodeLabels[], id: string, keepClasses: readonly string[]): KeepSystem {
  const bySnapshot = new Map<string, Set<number>>();
  for (const d of docs) {
    if (bySnapshot.has(d.snapshot_id)) throw new Error(`system "${id}": two NodeLabels documents for snapshot ${d.snapshot_id} (merge the labels of a snapshot first)`);
    const keep = new Set<number>();
    for (const item of d.items) {
      let y: 0 | 1;
      try {
        y = projectToBinary(item.y, d.label_space, keepClasses);
      } catch (e) {
        throw new Error(`system "${id}": ${e instanceof Error ? e.message : String(e)}`);
      }
      if (y === 1) keep.add(item.unit_id);
    }
    bySnapshot.set(d.snapshot_id, keep);
  }
  const labeler = docs[0]?.labeler;
  const space = docs[0]?.label_space;
  return {
    id,
    origin: `NodeLabels of ${labeler?.id ?? "?"}, ${space?.kind === "binary" ? "binary labels, y = 1 is keep" : `keep = ${keepClasses.join(" + ")}`}; ${docs.length} pages`,
    keepOf: (snapshotId) => bySnapshot.get(snapshotId) ?? null,
  };
}

function jsonLines(bytes: Uint8Array, what: string): unknown[] {
  const out: unknown[] = [];
  dec.decode(bytes).split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`${what}: line ${i + 1} is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
  });
  return out;
}

function predictionsSystem(h: ArtifactHandle, index: number): KeepSystem {
  let meta: Record<string, unknown> = {};
  let preds: unknown[];
  if (h.files().length === 0) {
    const doc = h.json();
    if (!isRecord(doc) || !Array.isArray(doc["predictions"])) throw new Error(`predictions artifact ${h.id}: expected { id, predictions: [{ g, u, p }] }`);
    meta = doc;
    preds = doc["predictions"];
  } else {
    if (!h.files().includes("predictions.jsonl")) throw new Error(`predictions artifact ${h.id} has no predictions.jsonl`);
    if (h.files().includes("system.json")) {
      const m = JSON.parse(dec.decode(h.file("system.json"))) as unknown;
      if (isRecord(m)) meta = m;
    }
    preds = jsonLines(h.file("predictions.jsonl"), "predictions.jsonl");
  }
  const id = typeof meta["id"] === "string" && meta["id"] !== "" ? meta["id"] : `predictions_${index}`;
  const threshold = typeof meta["threshold"] === "number" ? meta["threshold"] : 0.5;
  const byHex = new Map<string, Set<number>>();
  preds.forEach((r, i) => {
    const where = `system "${id}": prediction ${i + 1}`;
    if (!isRecord(r) || typeof r["g"] !== "string" || !Number.isInteger(r["u"])) throw new Error(`${where} needs g (string) and u (integer)`);
    const p = r["p"];
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw new Error(`${where}: p must be a number in [0, 1]`);
    const hash = r["g"].lastIndexOf("#");
    if (hash < 0) throw new Error(`${where}: g "${r["g"]}" is not "<group_key>#<snapshot hex12>"`);
    const key = r["g"].slice(hash + 1);
    const keep = byHex.get(key) ?? new Set<number>();
    byHex.set(key, keep);
    if (p >= threshold) keep.add(r["u"] as number);
  });
  return {
    id,
    origin: `predictions (threshold ${threshold}); ${byHex.size} pages`,
    keepOf: (snapshotId) => byHex.get(hex12(snapshotId)) ?? null,
  };
}

export interface SystemParams {
  keep_classes?: string[];
  names?: string[];
}

/** Every system supplied, in port order (`systems`, then `predictions`). Ids are file-name safe and unique. */
export function collectSystems(ctx: StageContext, p: SystemParams): KeepSystem[] {
  const keepClasses = p.keep_classes ?? DEFAULT_KEEP_CLASSES;
  const all: KeepSystem[] = [];
  const named = (default_: string): string => p.names?.[all.length] ?? default_;
  for (const h of handlesOf(ctx, "systems")) {
    const docs = labelDocs(h);
    if (docs.length === 0) throw new Error(`systems artifact ${h.id} has no ${NODE_LABELS} documents`);
    const kinds = new Set(docs.map((d) => d.labeler.kind));
    all.push(labelsSystem(docs, named(kinds.size === 1 ? (docs[0] as NodeLabels).labeler.kind : "labels"), keepClasses));
  }
  handlesOf(ctx, "predictions").forEach((h, i) => {
    const s = predictionsSystem(h, i);
    all.push(p.names?.[all.length] === undefined ? s : { ...s, id: p.names[all.length] as string });
  });
  const ids = all.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) throw new Error(`two systems claim the id "${dup}": name them with params.names (in port order: systems, then predictions)`);
  const bad = ids.find((id) => !SAFE_ID.test(id));
  if (bad !== undefined) throw new Error(`system id "${bad}" is not usable as a file name (letters, digits, ".", "_", "-"): name it with params.names`);
  return all;
}
