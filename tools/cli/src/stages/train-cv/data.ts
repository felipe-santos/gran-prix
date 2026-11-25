import { assertValid, canonicalJson, sha256Of, type DatasetManifest } from "@gran-prix/contracts";
import type { ArtifactHandle } from "../../store.js";
import type { DevRows } from "./cv.js";

/**
 * The dev rows of a Dataset (train + val, never test) held in memory with their original JSONL lines, so that a fold's
 * training set can be written back byte for byte (gp-train reads the same rows evaluate scores).
 */

const dec = new TextDecoder();

export interface DevData extends DevRows {
  manifest: DatasetManifest;
  n: number;
  dim: number;
  /** Feature rows, row-major, `n * dim`, BEFORE normalization (what a ModelPackage takes). */
  x: Float64Array;
  u: Int32Array;
  y: Uint8Array;
  w: Float64Array;
  /** `train` or `val`: the dataset's own split of every row (informational). */
  split: string[];
  stratum: string[];
  /** Original JSONL line of every row, without the newline. */
  line: string[];
  /** Whether `w` comes from the dataset (own-text characters) or is 1 per row. */
  weighted: boolean;
}

export function readDev(dataset: ArtifactHandle): DevData {
  if (!dataset.files().includes("manifest.json")) throw new Error(`dataset ${dataset.id} has no manifest.json: expected a Dataset file-set`);
  const manifest = assertValid("dataset-manifest", JSON.parse(dec.decode(dataset.file("manifest.json"))) as unknown);
  if (manifest.label_space.kind !== "binary") throw new Error(`the dataset's label space is "${manifest.label_space.kind}"; train.cv needs a binary (drop, keep) dataset`);
  const groups = new Map(manifest.groups.map((g) => [g.group_id, g]));
  const dim = manifest.dim;
  const weighted = manifest.row_weight !== undefined;
  const g: string[] = [];
  const key: string[] = [];
  const stratum: string[] = [];
  const split: string[] = [];
  const line: string[] = [];
  const us: number[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  const xs: number[] = [];
  for (const name of ["train", "val"] as const) {
    const file = `${name}.jsonl`;
    if (!dataset.files().includes(file)) throw new Error(`dataset ${dataset.id} has no ${file}`);
    dec
      .decode(dataset.file(file))
      .split("\n")
      .forEach((text, i) => {
        if (text.trim() === "") return;
        const r = JSON.parse(text) as { g?: unknown; u?: unknown; x?: unknown; y?: unknown; w?: unknown };
        const at = `${file} line ${i + 1}`;
        if (typeof r.g !== "string" || !Number.isInteger(r.u) || !Array.isArray(r.x) || (r.y !== 0 && r.y !== 1)) throw new Error(`${at}: not a binary dataset-row`);
        if (r.x.length !== dim) throw new Error(`${at}: ${r.x.length} features, the manifest says dim ${dim}`);
        const group = groups.get(r.g);
        if (!group) throw new Error(`${at}: group "${r.g}" is not in the manifest`);
        if (weighted && !(Number.isInteger(r.w) && (r.w as number) >= 0)) throw new Error(`${at}: the manifest declares row_weight, but w = ${String(r.w)}`);
        g.push(r.g);
        key.push(group.group_key);
        stratum.push(group.stratum);
        split.push(name);
        line.push(text);
        us.push(r.u as number);
        ys.push(r.y);
        ws.push(weighted ? (r.w as number) : 1);
        for (const v of r.x as number[]) xs.push(v);
      });
  }
  if (g.length === 0) throw new Error(`dataset ${dataset.id} has no dev rows (train + val are empty)`);
  return { manifest, n: g.length, dim, g, key, stratum, split, line, weighted, u: Int32Array.from(us), y: Uint8Array.from(ys), w: Float64Array.from(ws), x: Float64Array.from(xs) };
}

/** A rows file: the lines of `idx`, newline-terminated (empty for no rows). */
export function jsonl(dev: DevData, idx: readonly number[]): string {
  return idx.length === 0 ? "" : `${idx.map((i) => dev.line[i]).join("\n")}\n`;
}

/**
 * The manifest of a fold's dataset: the original, with `files` rewritten to a train file of `fitIdx` and EMPTY val and
 * test files. The trainer then fits on every row it is given (no early stopping, a fixed threshold) and never sees
 * the held-out fold, nor the test split.
 */
export function foldFiles(dev: DevData, fitIdx: readonly number[]): Record<string, string> {
  const train = jsonl(dev, fitIdx);
  const ref = (path: string, text: string, rows: number, pos: number): Record<string, unknown> => ({
    path,
    sha256: sha256Of(text),
    bytes: Buffer.byteLength(text),
    rows,
    pos_rate: rows > 0 ? pos / rows : 0,
  });
  const pos = fitIdx.reduce((a, i) => a + (dev.y[i] as number), 0);
  const manifest = {
    ...dev.manifest,
    files: { train: ref("train.jsonl", train, fitIdx.length, pos), val: ref("val.jsonl", "", 0, 0), test: ref("test.jsonl", "", 0, 0) },
  };
  return { "manifest.json": `${canonicalJson(manifest)}\n`, "train.jsonl": train, "val.jsonl": "", "test.jsonl": "" };
}
