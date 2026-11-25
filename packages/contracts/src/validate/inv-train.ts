import type { DatasetManifest, DatasetRow, SplitName } from "../dataset.js";
import { contractId } from "../identity/contract-ids.js";
import { assignSplit } from "../identity/split.js";
import type { LayerDef } from "../network-def.js";
import type { TrainConfig } from "../train-config.js";
import { Issues } from "./result.js";

const SPLITS = ["train", "val", "test"] as const satisfies readonly SplitName[];

export function datasetRowInvariants(r: DatasetRow): Issues {
  const out = new Issues("dataset-row");
  r.x.forEach((v, i) => out.check(Math.fround(v) === v, `x[${i}]`, `${v} is not a float32 value (apply Math.fround before serializing)`));
  return out;
}

export function datasetInvariants(m: DatasetManifest): Issues {
  const out = new Issues("dataset-manifest");
  const { ranges, salt, overrides, group_by } = m.split;

  // Ranges must tile [0, n_buckets) exactly: no overlap, no gap.
  const sorted = SPLITS.map((n) => ({ n, r: ranges[n] })).sort((a, b) => a.r[0] - b.r[0]);
  let cursor = 0;
  for (const { n, r } of sorted) {
    out.check(r[0] < r[1], `split.ranges.${n}`, `range [${r[0]}, ${r[1]}) is empty or inverted`);
    out.check(r[0] === cursor, `split.ranges.${n}`, `ranges must tile [0, ${m.split.n_buckets}) without gap or overlap (expected start ${cursor}, got ${r[0]})`);
    cursor = r[1];
  }
  out.check(cursor === m.split.n_buckets, "split.ranges", `ranges must end at ${m.split.n_buckets}, got ${cursor}`);

  const groupIds = new Set<string>();
  const splitOfKey = new Map<string, { split: SplitName; at: number }>();
  const rowsBySplit: Record<SplitName, number> = { train: 0, val: 0, test: 0 };
  m.groups.forEach((g, i) => {
    const at = `groups[${i}]`;
    out.check(!groupIds.has(g.group_id), `${at}.group_id`, `duplicate group_id "${g.group_id}"`);
    groupIds.add(g.group_id);
    if (i > 0) out.check(g.group_id > (m.groups[i - 1] as { group_id: string }).group_id, `${at}.group_id`, "groups must be sorted by group_id");
    out.check(g.n_pos <= g.n_rows, `${at}.n_pos`, "n_pos must be <= n_rows");
    rowsBySplit[g.split] += g.n_rows;

    // Recompute the bucket: proves the split really is the documented hash scheme.
    const hashed = group_by === "group_key" ? g.group_key : g.group_id;
    const expected = assignSplit(salt, hashed, { ranges, nBuckets: m.split.n_buckets, overrides: group_by === "group_key" ? overrides : {} });
    out.check(g.bucket === expected.bucket, `${at}.bucket`, `bucket ${g.bucket} != recomputed ${expected.bucket} for ${group_by} "${hashed}" (salt "${salt}")`);
    out.check(g.split === expected.split, `${at}.split`, `split "${g.split}" != expected "${expected.split}" (hash bucket ${expected.bucket}${overrides[g.group_key] ? ", override" : ""})`);

    // Anti-leakage: with group_by "group_key", one key lives in exactly one split.
    if (group_by === "group_key") {
      const prev = splitOfKey.get(g.group_key);
      if (prev && prev.split !== g.split) {
        out.invariant(`${at}.split`, `LEAKAGE: group_key "${g.group_key}" is in both "${prev.split}" (groups[${prev.at}]) and "${g.split}"`);
      }
      splitOfKey.set(g.group_key, { split: g.split, at: i });
    }
  });

  // v1.1: tags are sorted and unique per group; stats.by_tag is recomputable from them.
  const tagStats = new Map<string, { groups: number; rows: number }>();
  m.groups.forEach((g, i) => {
    (g.tags ?? []).forEach((t, k) => {
      if (k > 0) out.check(t > (g.tags as string[])[k - 1]!, `groups[${i}].tags[${k}]`, "tags must be sorted ascending, without duplicates");
      const e = tagStats.get(t) ?? { groups: 0, rows: 0 };
      e.groups++;
      e.rows += g.n_rows;
      tagStats.set(t, e);
    });
  });
  if (m.stats.by_tag) {
    for (const [t, v] of Object.entries(m.stats.by_tag)) {
      out.check(/^[a-z][a-z0-9_]*(:[A-Za-z0-9_.-]+)?$/.test(t), `stats.by_tag.${t}`, "tag must be key or key:value");
      const e = tagStats.get(t);
      out.check(e !== undefined, `stats.by_tag.${t}`, `no group carries the tag "${t}"`);
      if (e) {
        out.check(v.groups === e.groups, `stats.by_tag.${t}.groups`, `${v.groups} groups declared, groups[] carries the tag ${e.groups} times`);
        out.check(v.rows === e.rows, `stats.by_tag.${t}.rows`, `${v.rows} rows declared, tagged groups sum to ${e.rows}`);
      }
    }
    for (const t of tagStats.keys()) out.check(t in m.stats.by_tag, `stats.by_tag`, `missing entry for tag "${t}"`);
  }

  m.sources.forEach((s, i) => out.check(groupIds.has(s.group_id), `sources[${i}].group_id`, `"${s.group_id}" is not in groups`));
  for (const n of SPLITS) {
    out.check(m.files[n].rows === rowsBySplit[n], `files.${n}.rows`, `${m.files[n].rows} rows declared, but groups of split "${n}" sum to ${rowsBySplit[n]}`);
    out.check(m.files[n].path === `${n}.jsonl`, `files.${n}.path`, `must be "${n}.jsonl"`);
  }
  if (m.label_projection) {
    out.check(m.label_space.kind === "binary", "label_space", "a projected dataset must have a binary label_space");
    const names: readonly string[] = m.label_projection.from.classes;
    m.label_projection.keep_classes.forEach((c, i) =>
      out.check(names.includes(c), `label_projection.keep_classes[${i}]`, `"${c}" is not a class of label_projection.from`),
    );
  }
  out.idCheck(m.dataset_id === contractId("dataset-manifest", m), "dataset_id", "does not match the hash of the manifest (excluding dataset_id and provenance)");
  return out;
}

const WASM_UNSAFE: ReadonlySet<LayerDef["type"]> = new Set(["dropout", "batchnorm", "rnn", "gru"]);
const WASM_LINT_REASON: Record<string, string> = {
  dropout: "Dropout is a no-op in the wasm trainer (set_training is never enabled)",
  batchnorm: "BatchNorm has no running stats in the wasm trainer, so predict != predictBatch",
  rnn: "recurrent hidden state is not persisted (KNOWN-GAPS)",
  gru: "recurrent hidden state is not persisted (KNOWN-GAPS)",
};

export function trainConfigInvariants(c: TrainConfig): Issues {
  const out = new Issues("train-config");
  let outputDim: number | undefined;
  if (c.network.kind === "def") {
    const layers = c.network.def.layers;
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i] as LayerDef;
      if (l.type === "linear") {
        outputDim = l.out_features;
        break;
      }
    }
    if (c.runtime.engine === "wasm-node") {
      layers.forEach((l, i) => {
        if (WASM_UNSAFE.has(l.type)) out.add("lint", `network.def.layers[${i}]`, `${l.type}: ${WASM_LINT_REASON[l.type]}; refused for engine "wasm-node"`);
      });
    }
  } else {
    outputDim = 1; // mlp template is a single-logit binary head
  }
  if (outputDim !== undefined) {
    out.check(c.loss !== "bce_logits" || outputDim === 1, "loss", `bce_logits needs a single output unit, network ends with ${outputDim}`);
    out.check(c.loss !== "ce_logits" || outputDim > 1, "loss", `ce_logits needs more than one output unit, network ends with ${outputDim}`);
  }
  if (c.lr_schedule?.kind === "cosine") {
    out.check(c.lr_schedule.min_lr <= c.optimizer.lr, "lr_schedule.min_lr", "min_lr must be <= optimizer.lr");
  }
  if (c.data.class_balance.strategy === "pos_weight") {
    out.check(c.data.class_balance.pos_weight !== undefined, "data.class_balance.pos_weight", 'strategy "pos_weight" requires pos_weight');
    out.check(c.runtime.engine === "gp-train", "data.class_balance.strategy", 'pos_weight is only supported by engine "gp-train"');
  }
  if (c.sample_weight === "row") {
    out.check(c.runtime.engine === "gp-train", "sample_weight", 'sample_weight "row" is only supported by engine "gp-train"');
  }
  if (c.train_config_id !== undefined) {
    out.idCheck(c.train_config_id === contractId("train-config", c), "train_config_id", "does not match the hash of the config");
  }
  return out;
}
