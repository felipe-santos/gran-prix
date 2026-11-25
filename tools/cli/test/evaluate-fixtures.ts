import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertValid, canonicalJson, contractId, groupBucket, sha256Of, type DatasetManifest, type PipelineSpec, type Sha256, type SplitName } from "@gran-prix/contracts";
import { ArtifactStore, dataPaths } from "../src/index.js";
import { makeRng } from "../src/stages/evaluate/bootstrap.js";
import { EVALUATE_IMPL } from "../src/stages/evaluate/stage.js";
import { tmpDir } from "./helpers.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "contracts", "fixtures", "valid");
export const MODEL_DIR = join(FIXTURES, "model-package");

/** The contract fixture ModelPackage as a file set (what a `ModelPackage` artifact holds). */
export function modelFiles(): Record<string, Uint8Array> {
  return Object.fromEntries(readdirSync(MODEL_DIR).map((f) => [f, new Uint8Array(readFileSync(join(MODEL_DIR, f)))]));
}

export interface SynthGroup {
  id: string;
  key: string;
  stratum: string;
  split: SplitName;
  /** Snapshot the page stands for (manifest `sources[].source_id`), so NodeLabels can be matched to it. */
  snapshot?: Sha256;
  tags?: string[];
}

export interface SynthRow {
  g: string;
  u: number;
  x: number[];
  y: 0 | 1;
  s: string;
  /** Own-text characters (Dataset 1.1 `w`). */
  w?: number;
}

export interface BuildOptions {
  /** Write `w` on every row (rows without one get `defaultWeight(row)`) and `row_weight` in the manifest. */
  rowWeight?: boolean;
}

/** A deterministic own-text length, unrelated to the features. */
export const defaultWeight = (r: Pick<SynthRow, "g" | "u">): number => 3 + ((r.u * 37 + r.g.length * 11) % 90);

export const snapshotOf = (i: number): Sha256 => `sha256:${i.toString(16).padStart(64, "0")}`;

/** Four fixture features: log_text_len, link_density, is_heading, depth_norm. The label follows them loosely. */
export function synthRows(groups: readonly SynthGroup[], perGroup: number, seed: number): SynthRow[] {
  const rng = makeRng(seed);
  const rows: SynthRow[] = [];
  for (const g of groups) {
    for (let u = 0; u < perGroup; u++) {
      const text = rng();
      const link = rng();
      const heading = rng() < 0.2 ? 1 : 0;
      const depth = rng() * 0.5;
      const y = text * 0.8 - link * 0.6 + heading * 0.3 + (rng() - 0.5) * 0.5 > 0.1 ? 1 : 0;
      const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
      rows.push({ g: g.id, u, x: [r6(text), r6(link), heading, r6(depth)], y, s: rng() < 0.7 ? "human" : "llm" });
    }
  }
  return rows;
}

/** A VALID Dataset artifact (manifest + three jsonl files) around the given groups and rows; the template is the contract fixture. */
export function buildDataset(groups: readonly SynthGroup[], rows: readonly SynthRow[], opts: BuildOptions = {}): Record<string, string> {
  const { row_weight: _rw, ...template } = JSON.parse(readFileSync(join(FIXTURES, "dataset", "manifest.json"), "utf8")) as DatasetManifest; // the fixture declares row_weight; the rows built here only carry w on request
  const sorted = [...groups].sort((a, b) => (a.id < b.id ? -1 : 1));
  const files: Record<string, string> = {};
  const stats: Record<SplitName, { rows: number; pos: number }> = { train: { rows: 0, pos: 0 }, val: { rows: 0, pos: 0 }, test: { rows: 0, pos: 0 } };
  for (const split of ["train", "val", "test"] as const) {
    const ids = new Set(sorted.filter((g) => g.split === split).map((g) => g.id));
    const mine = rows.filter((r) => ids.has(r.g)).sort((a, b) => (a.g === b.g ? a.u - b.u : a.g < b.g ? -1 : 1));
    files[`${split}.jsonl`] = mine.map((r) => canonicalJson({ g: r.g, u: r.u, x: r.x, y: r.y, c: 0.9, s: r.s, ...(opts.rowWeight ? { w: r.w ?? defaultWeight(r) } : {}) })).join("\n") + "\n";
    stats[split] = { rows: mine.length, pos: mine.filter((r) => r.y === 1).length };
  }
  const fileRef = (split: SplitName) => ({
    path: `${split}.jsonl`,
    sha256: sha256Of(files[`${split}.jsonl`] as string),
    bytes: Buffer.byteLength(files[`${split}.jsonl`] as string),
    rows: stats[split].rows,
    pos_rate: stats[split].rows > 0 ? stats[split].pos / stats[split].rows : 0,
  });
  const strata = [...new Set(sorted.map((g) => g.stratum))].sort();
  const manifest = {
    ...template,
    ...(opts.rowWeight ? { row_weight: "own_text_chars" as const } : {}),
    sources: sorted.map((g) => ({ group_id: g.id, ...(g.snapshot ? { source_id: g.snapshot } : {}), features_id: template.sources[0]!.features_id, labels_id: template.sources[0]!.labels_id })),
    groups: sorted.map((g) => ({
      group_id: g.id,
      group_key: g.key,
      stratum: g.stratum,
      split: g.split,
      bucket: groupBucket(template.split.salt, g.key),
      n_rows: rows.filter((r) => r.g === g.id).length,
      n_pos: rows.filter((r) => r.g === g.id && r.y === 1).length,
      ...(g.tags ? { tags: g.tags } : {}),
    })),
    split: { ...template.split, overrides: Object.fromEntries(sorted.map((g) => [g.key, g.split])) },
    files: { train: fileRef("train"), val: fileRef("val"), test: fileRef("test") },
    stats: {
      by_split: Object.fromEntries((["train", "val", "test"] as const).map((s) => [s, { rows: stats[s].rows, pos_rate: fileRef(s).pos_rate }])),
      by_stratum: Object.fromEntries(
        strata.map((s) => {
          const ids = new Set(sorted.filter((g) => g.stratum === s).map((g) => g.id));
          const mine = rows.filter((r) => ids.has(r.g));
          return [s, { groups: ids.size, rows: mine.length, pos_rate: mine.length ? mine.filter((r) => r.y === 1).length / mine.length : 0 }];
        }),
      ),
    },
  };
  const withId = { ...manifest, dataset_id: contractId("dataset-manifest", manifest as unknown as Record<string, unknown>) };
  assertValid("dataset-manifest", withId);
  files["manifest.json"] = `${JSON.stringify(withId, null, 2)}\n`;
  return files;
}

/** 12 pages over 8 domains and 3 strata: 8 pages in test (6 domains), 2 val, 2 train. */
export const GROUPS: SynthGroup[] = [
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i): SynthGroup => ({ id: `t${i}`, key: `test${Math.floor(i / 2) % 4}.example`, stratum: ["forum", "docs", "shop", "docs"][Math.floor(i / 2)] as string, split: "test", snapshot: snapshotOf(i + 1) })),
  { id: "v0", key: "val0.example", stratum: "docs", split: "val", snapshot: snapshotOf(9) },
  { id: "v1", key: "val1.example", stratum: "shop", split: "val", snapshot: snapshotOf(10) },
  { id: "r0", key: "train0.example", stratum: "forum", split: "train", snapshot: snapshotOf(11) },
  { id: "r1", key: "train1.example", stratum: "docs", split: "train", snapshot: snapshotOf(12) },
];

export const specWith = (stage: PipelineSpec["stages"][number], externals: NonNullable<PipelineSpec["externals"]>): PipelineSpec => ({
  format: "gran-prix.pipeline-spec",
  format_version: "1.0.0",
  name: "eval-mini",
  externals,
  stages: [stage],
});

export const ROWS = synthRows(GROUPS, 14, 5);
export const OP = 0.42;
export const WEIGHT = { feature: "log_text_len", log1p_scale: 10 } as const;

export interface World {
  dataDir: string;
  store: ArtifactStore;
  externals: NonNullable<PipelineSpec["externals"]>;
}

export function world(withBaseline = true, build: BuildOptions = {}): World {
  const dataDir = tmpDir();
  const store = new ArtifactStore(dataPaths(dataDir).artifacts);
  const model = store.putFiles("ModelPackage", modelFiles());
  const dataset = store.putFiles("Dataset", buildDataset(GROUPS, ROWS, build));
  const externals: World["externals"] = { model: { type: "ModelPackage", id: model }, dataset: { type: "Dataset", id: dataset } };
  if (withBaseline) {
    // A "heuristic": keep when the element has long text and few links. Covers every test unit.
    const predictions = ROWS.map((r) => ({ g: r.g, u: r.u, p: (r.x[0] as number) - (r.x[1] as number) * 0.5 > 0.3 ? 1 : 0 }));
    externals["heur"] = { type: "Bundle", id: store.putJson("Bundle", { id: "heur", predictions }) };
  }
  return { dataDir, store, externals };
}

export const stage = (params: Record<string, unknown>, baselines = true): PipelineSpec["stages"][number] => ({
  id: "eval",
  kind: "evaluate",
  impl: EVALUATE_IMPL,
  params,
  inputs: {
    model: { external: "model" },
    dataset: { external: "dataset" },
    ...(baselines ? { baselines: [{ external: "heur" }] } : {}),
  },
});

export const PARAMS = {
  seed: 20261125,
  split: "test",
  resamples: 200,
  // The fixture model scores everything in roughly [0.3, 0.5]; its package threshold (0.7) keeps nothing, so evaluate at 0.42.
  threshold: OP,
  weight: WEIGHT,
  gates: [
    { id: "f1_floor", name: "F1 floor", metric: "f1", comparator: ">=", threshold: 0.2 },
    { id: "gain_vs_heur", name: "Gain over the heuristic", metric: "f1", comparator: ">=", threshold: -1, baseline: "heur", use_ci_lower: true },
  ],
};

