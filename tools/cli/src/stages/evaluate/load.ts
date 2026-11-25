import { join } from "node:path";
import { assertValid, type DatasetManifest } from "@gran-prix/contracts";
import { loadModelPackage, type LoadedModel, type Runtime } from "@gran-prix/model";
import type { ArtifactHandle } from "../../store.js";
import { unitKeyOf } from "./core.js";

/** Everything the evaluator reads from its inputs: the split's rows (scored later), the manifest and baseline predictions. */

/** `dev` = train + val: the rows every choice (tuning, tau*) is allowed to see; the test split is NOT read. */
export type SplitParam = "train" | "val" | "dev" | "test" | "all";

export interface DataRow {
  g: string;
  u: number;
  x: number[];
  y: number;
  s: string;
  /** Own-text characters of the unit (Dataset 1.1 `w`); present on every row iff the manifest declares `row_weight`. */
  w?: number;
}

const dec = new TextDecoder();

function jsonLines(bytes: Uint8Array, what: string): unknown[] {
  const out: unknown[] = [];
  const lines = dec.decode(bytes).split("\n");
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`${what}: line ${i + 1} is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
  });
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads `manifest.json` and the row files of the split from a `Dataset` artifact (a file set). */
export function readDataset(h: ArtifactHandle, split: SplitParam): { manifest: DatasetManifest; rows: DataRow[] } {
  if (!h.files().includes("manifest.json")) throw new Error(`dataset artifact ${h.id} has no manifest.json (files: ${h.files().join(", ") || "none"})`);
  const manifest = assertValid("dataset-manifest", JSON.parse(dec.decode(h.file("manifest.json"))) as unknown);
  const ls = manifest.label_space;
  if (ls.kind !== "binary") throw new Error(`the dataset's label space is "${ls.kind}"; evaluate needs a binary (drop, keep) dataset: project the labels first`);
  const names = split === "all" ? (["train", "val", "test"] as const) : split === "dev" ? (["train", "val"] as const) : [split];
  const rows: DataRow[] = [];
  for (const name of names) {
    const file = `${name}.jsonl`;
    if (!h.files().includes(file)) throw new Error(`dataset artifact ${h.id} has no ${file}`);
    const parsed = jsonLines(h.file(file), file);
    parsed.forEach((r, i) => {
      if (!isRecord(r) || typeof r["g"] !== "string" || !Number.isInteger(r["u"]) || !Array.isArray(r["x"]) || (r["y"] !== 0 && r["y"] !== 1) || typeof r["s"] !== "string") {
        throw new Error(`${file}: row ${i + 1} is not a binary dataset-row (needs g, u, x, y in {0,1}, s)`);
      }
      if (r["x"].length !== manifest.dim) throw new Error(`${file}: row ${i + 1} has ${r["x"].length} features, the manifest says dim ${manifest.dim}`);
      const w = r["w"];
      if (w !== undefined && !(Number.isInteger(w) && (w as number) >= 0)) throw new Error(`${file}: row ${i + 1} has w = ${String(w)}, expected a non-negative integer`);
      if (manifest.row_weight !== undefined && w === undefined) throw new Error(`${file}: row ${i + 1} has no w, but the manifest declares row_weight "${manifest.row_weight}"`);
      rows.push({ g: r["g"], u: r["u"] as number, x: r["x"] as number[], y: r["y"], s: r["s"], ...(w !== undefined ? { w: w as number } : {}) });
    });
  }
  return { manifest, rows };
}

export interface ModelHandle {
  model: LoadedModel;
  /** Index of the positive ("keep") class in the model's output. */
  positive: number;
}

/** Loads and verifies the ModelPackage artifact (a file set holding model.json, network_def.json, weights.f32le, golden.json). */
export function readModel(h: ArtifactHandle, runtime: Runtime, positiveLabel: string): ModelHandle {
  if (!h.files().includes("model.json")) throw new Error(`model artifact ${h.id} has no model.json (files: ${h.files().join(", ") || "none"})`);
  const model = loadModelPackage(join(h.dir, "files"), { runtime });
  const labels = model.labels;
  // Sigmoid models have one output (P of labels[1]); softmax models one output per label.
  const positive = model.outputDim === 1 ? 0 : labels.indexOf(positiveLabel);
  const name = model.outputDim === 1 ? labels[1] : labels[positive];
  if (positive < 0 || name !== positiveLabel) {
    model.dispose();
    throw new Error(`the model's output labels are [${labels.join(", ")}]; the positive class "${positiveLabel}" is not where evaluate expects it`);
  }
  return { model, positive };
}

/** Scores `rows` (extractor features, BEFORE normalization) with the model: P(keep) per row. */
export function scoreRows(m: ModelHandle, rows: readonly DataRow[], chunk = 4096): Float64Array {
  const dim = m.model.inputDim;
  const out = new Float64Array(rows.length);
  for (let start = 0; start < rows.length; start += chunk) {
    const n = Math.min(chunk, rows.length - start);
    const x = new Float64Array(n * dim);
    for (let r = 0; r < n; r++) x.set((rows[start + r] as DataRow).x, r * dim);
    const p = m.model.predictBatch(x, n);
    for (let r = 0; r < n; r++) out[start + r] = p[r * m.model.outputDim + m.positive] as number;
  }
  return out;
}

export interface BaselineSystem {
  id: string;
  /** Predicted keep per unit (`g` + NUL + `u`). Units not listed are not covered. */
  keep: Map<string, boolean>;
  /** Where the predictions come from (for the notes). */
  origin?: string;
}

function toKeep(p: unknown, threshold: number, where: string): boolean {
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw new Error(`${where}: p must be a number in [0, 1]`);
  return p >= threshold;
}

/**
 * A baseline system's predictions for the same units, from a `Bundle` artifact in either form:
 *  - JSON: `{ id, threshold?, predictions: [{ g, u, p }] }`
 *  - file set: `predictions.jsonl` (one `{ g, u, p }` per line) and optional `system.json` (`{ id, threshold? }`)
 * `p` is 0/1 (hard prediction) or a score in [0, 1] compared with `threshold` (default 0.5).
 */
export function readBaseline(h: ArtifactHandle, index: number): BaselineSystem {
  let meta: Record<string, unknown> = {};
  let preds: unknown[];
  if (h.files().length === 0) {
    const doc = h.json();
    if (!isRecord(doc) || !Array.isArray(doc["predictions"])) throw new Error(`baseline artifact ${h.id}: expected { id, predictions: [{ g, u, p }] }`);
    meta = doc;
    preds = doc["predictions"];
  } else {
    if (!h.files().includes("predictions.jsonl")) throw new Error(`baseline artifact ${h.id} has no predictions.jsonl`);
    if (h.files().includes("system.json")) {
      const m = JSON.parse(dec.decode(h.file("system.json"))) as unknown;
      if (isRecord(m)) meta = m;
    }
    preds = jsonLines(h.file("predictions.jsonl"), "predictions.jsonl");
  }
  const id = typeof meta["id"] === "string" && meta["id"] !== "" ? meta["id"] : `baseline_${index}`;
  const threshold = typeof meta["threshold"] === "number" ? meta["threshold"] : 0.5;
  const keep = new Map<string, boolean>();
  preds.forEach((r, i) => {
    if (!isRecord(r) || typeof r["g"] !== "string" || !Number.isInteger(r["u"])) throw new Error(`baseline "${id}": prediction ${i + 1} needs g (string) and u (integer)`);
    keep.set(unitKeyOf(r["g"], r["u"] as number), toKeep(r["p"], threshold, `baseline "${id}": prediction ${i + 1}`));
  });
  return { id, keep };
}
