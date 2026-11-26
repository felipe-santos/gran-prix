/** Synthetic fixture documents for Dataset, TrainConfig and NetworkDef. */
import type { DatasetManifest, DatasetRow, SplitName } from "../../dataset.js";
import { contractId } from "../../identity/contract-ids.js";
import { sha256Of } from "../../identity/hash.js";
import { assignSplit, DEFAULT_SPLIT_RANGES } from "../../identity/split.js";
import { projectToBinary } from "../../labels.js";
import type { LabelSpace } from "../../node-labels.js";
import type { NetworkDef } from "../../network-def.js";
import type { TrainConfig } from "../../train-config.js";
import { FEATURE_ROWS, FEATURE_UNITS, sha } from "./extract-docs.js";

export const DATASET_SALT = "fixture-v1";
const THREE: LabelSpace = { kind: "multiclass", classes: ["main", "support", "noise"] };
const SOURCE_BY_UNIT = ["human", "llm", "heuristic"] as const;
const LABEL_BY_UNIT = [0, 0, 1]; // 3-class labels of units 2, 3, 4
const WEIGHT_BY_UNIT = [15, 25, 4]; // own_text_len of units 2, 3, 4 in the fixture snapshot

export interface DatasetFixture {
  manifest: DatasetManifest;
  /** File name -> text, for train.jsonl / val.jsonl / test.jsonl. */
  files: Record<SplitName, string>;
  rows: DatasetRow[];
}

/** Picks fixture domains so that every split gets at least one group (deterministic search). */
function pickDomains(): Array<{ key: string; split: SplitName; bucket: number }> {
  const want: Record<SplitName, number> = { train: 2, val: 1, test: 1 };
  const picked: Array<{ key: string; split: SplitName; bucket: number }> = [];
  for (let i = 0; picked.length < 4 && i < 5000; i++) {
    const key = `site${i}.example`;
    const { split, bucket } = assignSplit(DATASET_SALT, key);
    if (want[split] > 0) {
      want[split]--;
      picked.push({ key, split, bucket });
    }
  }
  return picked;
}

export function buildDataset(): DatasetFixture {
  const domains = pickDomains();
  const rows: DatasetRow[] = [];
  const groups: DatasetManifest["groups"] = [];
  domains.forEach((d, i) => {
    const group_id = `g${String(i).padStart(2, "0")}_${d.key.replace(".example", "")}`;
    const stratum = i % 2 === 0 ? "article" : "docs";
    const own = FEATURE_UNITS.map((u, k): DatasetRow => ({
      g: group_id,
      u,
      x: FEATURE_ROWS[k] as number[],
      y: projectToBinary(LABEL_BY_UNIT[k] as number, THREE),
      c: 0.9,
      s: SOURCE_BY_UNIT[k] as DatasetRow["s"],
      l: LABEL_BY_UNIT[k] as number,
      w: WEIGHT_BY_UNIT[k] as number,
    }));
    rows.push(...own);
    groups.push({
      group_id,
      group_key: d.key,
      stratum,
      split: d.split,
      bucket: d.bucket,
      n_rows: own.length,
      n_pos: own.filter((r) => r.y === 1).length,
      tags: i % 2 === 0 ? ["lang:en"] : ["lang:pt", "logged_in"],
    });
  });
  groups.sort((a, b) => (a.group_id < b.group_id ? -1 : 1));
  rows.sort((a, b) => (a.g === b.g ? a.u - b.u : a.g < b.g ? -1 : 1));

  const files = {} as Record<SplitName, string>;
  const fileMeta = {} as DatasetManifest["files"];
  for (const split of ["train", "val", "test"] as const) {
    const ids = new Set(groups.filter((g) => g.split === split).map((g) => g.group_id));
    const mine = rows.filter((r) => ids.has(r.g));
    const text = mine.map((r) => JSON.stringify(r)).join("\n") + (mine.length > 0 ? "\n" : "");
    files[split] = text;
    fileMeta[split] = {
      path: `${split}.jsonl`,
      sha256: sha256Of(text),
      bytes: Buffer.byteLength(text),
      media_type: "application/x-ndjson",
      rows: mine.length,
      pos_rate: mine.length === 0 ? 0 : mine.filter((r) => r.y === 1).length / mine.length,
    };
  }

  const by_split: DatasetManifest["stats"]["by_split"] = {};
  for (const s of ["train", "val", "test"] as const) by_split[s] = { rows: fileMeta[s].rows, pos_rate: fileMeta[s].pos_rate };
  const by_stratum: DatasetManifest["stats"]["by_stratum"] = {};
  for (const g of groups) {
    const e = (by_stratum[g.stratum] ??= { groups: 0, rows: 0, pos_rate: 0 });
    e.pos_rate = (e.pos_rate * e.rows + g.n_pos) / (e.rows + g.n_rows);
    e.groups++;
    e.rows += g.n_rows;
  }

  const by_tag: NonNullable<DatasetManifest["stats"]["by_tag"]> = {};
  for (const g of groups) {
    for (const t of g.tags ?? []) {
      const e = (by_tag[t] ??= { groups: 0, rows: 0, pos_rate: 0 });
      e.pos_rate = (e.pos_rate * e.rows + g.n_pos) / (e.rows + g.n_rows);
      e.groups++;
      e.rows += g.n_rows;
    }
  }

  const manifest: DatasetManifest = {
    format: "gran-prix.dataset-manifest",
    format_version: "1.1.0",
    dataset_id: sha("placeholder"),
    feature_schema_id: sha("feature-schema-placeholder"), // replaced by the caller
    dim: 4,
    row_weight: "own_text_chars",
    label_space: { kind: "binary", classes: ["drop", "keep"] },
    label_projection: { from: THREE, keep_classes: ["main", "support"] },
    sources: groups.map((g) => ({
      group_id: g.group_id,
      features_id: sha(`features:${g.group_id}`),
      labels_id: sha(`labels:${g.group_id}`),
    })),
    filters: {
      drop_unlabeled: true,
      min_confidence: 0.5,
      allowed_sources: ["human", "llm", "heuristic"],
      test_allowed_sources: ["human", "llm", "heuristic"],
      dedupe: "exact_x_per_group",
    },
    groups,
    excluded_pages: [{ source_id: sha("snapshot:paywalled"), group_key: "paywalled.example", flags: ["paywall"] }],
    split: {
      scheme: "hash-bucket-v1",
      group_by: "group_key",
      salt: DATASET_SALT,
      n_buckets: 100,
      ranges: {
        train: [...DEFAULT_SPLIT_RANGES.train] as [number, number],
        val: [...DEFAULT_SPLIT_RANGES.val] as [number, number],
        test: [...DEFAULT_SPLIT_RANGES.test] as [number, number],
      },
      overrides: {},
      kfold: { k: 5 },
    },
    files: fileMeta,
    stats: { by_split, by_stratum, by_tag },
  };
  return { manifest, files, rows };
}

/** Re-computes `dataset_id` after the caller filled in the real feature_schema_id. */
export function sealDataset(m: DatasetManifest): DatasetManifest {
  return { ...m, dataset_id: contractId("dataset-manifest", m) };
}

export const NETWORK_DEF: NetworkDef = {
  input_dim: 4,
  layers: [
    { type: "linear", in_features: 4, out_features: 3 },
    { type: "activation", function: "relu" },
    { type: "linear", in_features: 3, out_features: 1 },
  ],
};

export function buildTrainConfig(): TrainConfig {
  const doc: TrainConfig = {
    format: "gran-prix.train-config",
    format_version: "1.0.0",
    seed: 42,
    network: { kind: "mlp", hidden: [3], activation: "relu", input_dim: "auto" },
    loss: "bce_logits",
    optimizer: { kind: "adam", lr: 0.01 },
    lr_schedule: { kind: "cosine", min_lr: 0.0001 },
    epochs: 30,
    batch_size: 64,
    data: {
      min_confidence: 0.5,
      allowed_sources: ["human", "llm", "heuristic"],
      class_balance: { strategy: "pos_weight", pos_weight: 1.5 },
    },
    normalization: { kind: "zscore", fit_on: "train" },
    early_stopping: { metric: "val_loss", patience: 5, min_delta: 0.0001 },
    threshold: { strategy: "max_f1_on_val" },
    runtime: { engine: "gp-train" },
  };
  return { ...doc, train_config_id: contractId("train-config", doc) };
}

/**
 * v1.1: the same recipe with the per-row sample weight (`sample_weight: "row"`, the `w` column of the Dataset rows).
 * The main fixture (`buildTrainConfig`) stays a 1.0.0 document: a v1.0 config is still a valid config.
 */
export function buildTrainConfigRowWeight(): TrainConfig {
  const { train_config_id: _id, ...base } = buildTrainConfig();
  const doc: TrainConfig = { ...base, format_version: "1.1.0", sample_weight: "row" };
  return { ...doc, train_config_id: contractId("train-config", doc) };
}
