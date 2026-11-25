import { Type, type Static } from "@sinclair/typebox";
import { FileRef, NonNegInt, PosInt, Sha256, Unit01, contractObject, defineContract } from "./base.js";
import { LabelSource, LabelSpace } from "./node-labels.js";

/**
 * Dataset (generic): a manifest plus `train.jsonl`, `val.jsonl`, `test.jsonl`.
 * Speaks in unit (row), group (what the split must not cut: a page) and
 * stratum (reporting category). Split = hash bucket of `group_key` (ADR-006:
 * for the DOM pipeline `group_key` is the registrable domain), never a PRNG.
 */

export const SplitName = Type.Union([Type.Literal("train"), Type.Literal("val"), Type.Literal("test")]);
export type SplitName = Static<typeof SplitName>;

/** `key` or `key:value`, e.g. `logged_in`, `lang:pt`, `content_type:forum`. */
export const Tag = Type.String({ pattern: "^[a-z][a-z0-9_]*(:[A-Za-z0-9_.-]+)?$", description: "key or key:value." });

/** One JSONL line. Short keys on purpose (file size). Rows sorted by (g, u). */
export const DatasetRowContract = defineContract(
  "dataset-row",
  "gran-prix.dataset-row",
  "1.1.0",
  Type.Object(
    {
      g: Type.String({ minLength: 1, description: "group_id (a page)." }),
      u: NonNegInt,
      x: Type.Array(Type.Number(), { description: "Features after static transform, BEFORE fitted normalization." }),
      y: NonNegInt,
      c: Unit01,
      s: LabelSource,
      l: Type.Optional(NonNegInt),
      w: Type.Optional(NonNegInt),
    },
    {
      $id: "urn:gran-prix:schema:dataset-row",
      title: "dataset-row",
      description:
        "One JSONL row: g = group_id, u = unit_id, x = features, y = training target, c = label confidence, s = label source, l = label in the source (e.g. 3-class) space when y is a projection, w (v1.1) = evaluation weight: the unit's own-text length in Unicode code points (NFC, whitespace collapsed), declared by the manifest's row_weight. No format envelope (one object per line).",
    },
  ),
);
export const DatasetRowSchema = DatasetRowContract.schema;
export type DatasetRow = Static<typeof DatasetRowSchema>;

const FileStats = Type.Object({
  ...FileRef.properties,
  rows: NonNegInt,
  pos_rate: Unit01,
});

const Range = Type.Tuple([Type.Integer({ minimum: 0 }), Type.Integer({ minimum: 0 })], { description: "[lo, hi) over buckets." });

export const DatasetManifestContract = defineContract(
  "dataset-manifest",
  "gran-prix.dataset-manifest",
  "1.1.0",
  contractObject(
    "dataset-manifest",
    "gran-prix.dataset-manifest",
    {
      dataset_id: Sha256,
      feature_schema_id: Sha256,
      dim: PosInt,
      row_weight: Type.Optional(
        Type.Literal("own_text_chars", {
          description: "v1.1: when present, every row carries `w` = own-text length of its unit (the weight of the char-weighted metrics).",
        }),
      ),
      label_space: LabelSpace,
      label_projection: Type.Optional(
        Type.Object({
          from: LabelSpace,
          keep_classes: Type.Array(Type.String()),
        }),
      ),
      sources: Type.Array(
        Type.Object({
          group_id: Type.String({ minLength: 1 }),
          source_id: Type.Optional(Sha256),
          features_id: Sha256,
          labels_id: Sha256,
        }),
      ),
      filters: Type.Object({
        drop_unlabeled: Type.Boolean(),
        min_confidence: Unit01,
        allowed_sources: Type.Array(LabelSource),
        test_allowed_sources: Type.Optional(
          Type.Array(LabelSource, { description: "Restricts the test split (e.g. [human]), ADR-006." }),
        ),
        dedupe: Type.Union([Type.Literal("none"), Type.Literal("exact_x_per_group")]),
      }),
      groups: Type.Array(
        Type.Object({
          group_id: Type.String({ minLength: 1 }),
          group_key: Type.String({ minLength: 1 }),
          stratum: Type.String({ minLength: 1 }),
          split: SplitName,
          bucket: NonNegInt,
          n_rows: NonNegInt,
          n_pos: NonNegInt,
          tags: Type.Optional(Type.Array(Tag, { description: "v1.1 (C9): extra slices of the group (logged_in, lang:pt, ...), sorted ascending, unique." })),
        }),
        { description: "Sorted by group_id." },
      ),
      split: Type.Object({
        scheme: Type.Literal("hash-bucket-v1"),
        group_by: Type.Union([Type.Literal("group_key"), Type.Literal("group")], {
          description: "group_key (default): all groups sharing the key stay together, e.g. same domain.",
        }),
        salt: Type.String(),
        n_buckets: Type.Literal(100),
        ranges: Type.Object({ train: Range, val: Range, test: Range }),
        overrides: Type.Record(Type.String(), SplitName),
        kfold: Type.Optional(Type.Object({ k: Type.Integer({ minimum: 2 }) })),
      }),
      files: Type.Object({ train: FileStats, val: FileStats, test: FileStats }),
      stats: Type.Object({
        by_split: Type.Record(Type.String(), Type.Object({ rows: NonNegInt, pos_rate: Unit01 })),
        by_stratum: Type.Record(Type.String(), Type.Object({ groups: NonNegInt, rows: NonNegInt, pos_rate: Unit01 })),
        by_tag: Type.Optional(
          Type.Record(Type.String(), Type.Object({ groups: NonNegInt, rows: NonNegInt, pos_rate: Unit01 }), {
            description: "v1.1: same shape as by_stratum, keyed by tag. Recomputable from groups[].tags.",
          }),
        ),
      }),
    },
    "Dataset manifest: feature schema binding, label space, hash-bucket split by group_key, file hashes.",
  ),
);
export const DatasetManifestSchema = DatasetManifestContract.schema;
export type DatasetManifest = Static<typeof DatasetManifestSchema>;
