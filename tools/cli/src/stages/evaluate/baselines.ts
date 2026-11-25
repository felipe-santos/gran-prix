import { DEFAULT_KEEP_CLASSES, assertValid, projectToBinary, type DatasetManifest, type NodeLabels } from "@gran-prix/contracts";
import type { StageContext } from "../../stage.js";
import type { ArtifactHandle } from "../../store.js";
import { unitKeyOf } from "./core.js";
import { readBaseline, type BaselineSystem } from "./load.js";

/**
 * Baseline systems of the evaluate stage. An input artifact is either a prediction Bundle (see `readBaseline`) or
 * NodeLabels (one document per page, e.g. the `label.heuristic` / Readability output). NodeLabels become predictions
 * for the units of the dataset: keep = the labels' classes in `keep_classes` (default main + support), and a unit the
 * labeler did not label is NOT covered (it is left out of that baseline and of every paired difference with it).
 *
 * Two ports feed it: `baselines` (Bundle, `many`; also takes NodeLabels written as a Bundle) and `label_baselines`
 * (NodeLabelsSet, `many`: the port a pipeline can wire straight to a label stage, since edges are type-checked).
 */

export interface LabelBaselineParam {
  /** Classes of the labels' space that mean keep. Default main + support; ignored for a binary label space. */
  keep_classes?: string[];
  /** Ids of the NodeLabels baselines, in port order (`baselines` then `label_baselines`). Default: the labeler kind. */
  names?: string[];
}

export const LABEL_BASELINE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    keep_classes: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, description: "Label classes that mean keep (default main + support)." },
    names: { type: "array", items: { type: "string", minLength: 1 }, description: "Ids of the NodeLabels baselines in port order; default: the labeler kind (readability, heuristic, ...)." },
  },
} as const;

const NODE_LABELS = "gran-prix.node-labels";
const dec = new TextDecoder();

const isLabels = (v: unknown): v is NodeLabels => typeof v === "object" && v !== null && (v as { format?: unknown }).format === NODE_LABELS;

/** The NodeLabels documents of an artifact: the `.json` members of a file set, or the document(s) of a JSON artifact. */
export function nodeLabelsIn(h: ArtifactHandle): NodeLabels[] {
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
      // empty file set
    }
  }
  return docs.filter(isLabels).map((d) => assertValid("node-labels", d));
}

/** snapshot_id -> the dataset's group_id (manifest sources, else the `#<snapshot hex12>` suffix of the group id). */
function groupResolver(manifest: DatasetManifest): (snapshotId: string) => string | undefined {
  const bySource = new Map(manifest.sources.flatMap((s) => (s.source_id !== undefined ? [[s.source_id, s.group_id] as const] : [])));
  return (snapshotId) => bySource.get(snapshotId as `sha256:${string}`) ?? manifest.groups.find((g) => g.group_id.endsWith(`#${snapshotId.slice("sha256:".length, "sha256:".length + 12)}`))?.group_id;
}

export function labelsBaseline(docs: readonly NodeLabels[], manifest: DatasetManifest, id: string, keepClasses: readonly string[]): BaselineSystem {
  const resolve = groupResolver(manifest);
  const keep = new Map<string, boolean>();
  const seen = new Set<string>();
  let inDataset = 0;
  for (const d of docs) {
    if (seen.has(d.snapshot_id)) throw new Error(`NodeLabels baseline "${id}": two documents for snapshot ${d.snapshot_id} (merge the labels of a snapshot first)`);
    seen.add(d.snapshot_id);
    const gid = resolve(d.snapshot_id);
    if (gid === undefined) continue; // a page the dataset does not have
    inDataset++;
    for (const item of d.items) {
      try {
        keep.set(unitKeyOf(gid, item.unit_id), projectToBinary(item.y, d.label_space, keepClasses) === 1);
      } catch (e) {
        throw new Error(`NodeLabels baseline "${id}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  const labeler = docs[0]?.labeler;
  const space = docs[0]?.label_space;
  const keepText = space?.kind === "binary" ? "binary labels, y = 1 is keep" : `keep = ${keepClasses.join(" + ")}`;
  return { id, keep, origin: `NodeLabels of ${labeler?.id ?? "?"}, ${keepText}; ${inDataset} of ${docs.length} labeled pages are in the dataset` };
}

const handlesOf = (ctx: StageContext, port: string): ArtifactHandle[] => {
  const v = ctx.inputs[port];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
};

/** Every baseline system supplied, in port order (`baselines`, then `label_baselines`), optionally restricted and ordered by `wanted`. */
export function collectBaselines(ctx: StageContext, manifest: DatasetManifest, wanted: readonly string[] | undefined, label: LabelBaselineParam | undefined): BaselineSystem[] {
  const keepClasses = label?.keep_classes ?? DEFAULT_KEEP_CLASSES;
  const all: BaselineSystem[] = [];
  let labelIndex = 0;
  const fromLabels = (docs: NodeLabels[]): BaselineSystem => {
    const kinds = new Set(docs.map((d) => d.labeler.kind));
    const id = label?.names?.[labelIndex] ?? (kinds.size === 1 ? (docs[0] as NodeLabels).labeler.kind : "labels");
    labelIndex++;
    return labelsBaseline(docs, manifest, id, keepClasses);
  };
  handlesOf(ctx, "baselines").forEach((h, i) => {
    const docs = nodeLabelsIn(h);
    all.push(docs.length > 0 ? fromLabels(docs) : readBaseline(h, i));
  });
  for (const h of handlesOf(ctx, "label_baselines")) {
    const docs = nodeLabelsIn(h);
    if (docs.length === 0) throw new Error(`label_baselines artifact ${h.id} has no ${NODE_LABELS} documents`);
    all.push(fromLabels(docs));
  }
  const ids = all.map((b) => b.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) throw new Error(`two baseline artifacts claim the id "${dup}"${label === undefined ? "" : " (name NodeLabels baselines with params.label_baseline.names)"}`);
  if (wanted === undefined) return all;
  return wanted.map((id) => {
    const found = all.find((b) => b.id === id);
    if (!found) throw new Error(`params.baselines lists "${id}", but the supplied baseline systems are: ${ids.join(", ") || "none"}`);
    return found;
  });
}
