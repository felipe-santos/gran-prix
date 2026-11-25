import {
  BINARY_SPACE,
  DEFAULT_KEEP_CLASSES,
  LABEL_SOURCES,
  assignSplit,
  DEFAULT_SPLIT_RANGES,
  contractId,
  projectToBinary,
  sha256Of,
  type DatasetManifest,
  type DatasetRow,
  type FeatureSchema,
  type LabelSource,
  type NodeFeatures,
  type NodeLabels,
  type SplitName,
  type SplitRanges,
} from "@gran-prix/contracts";

/**
 * Dataset builder (contracts: dataset-manifest + dataset-row). Joins feature rows with labels per page,
 * projects 3-class labels to binary (keep = main + support by default, recorded in the manifest), splits
 * BY GROUP (domain, `hash-bucket-v1`: never a PRNG, never by row) and writes the JSONL files.
 *
 * Deterministic: the same inputs and params give byte-identical files and the same `dataset_id`.
 * Rows are ordered by (group, page, unit): `group_id` is "<group_key>#<snapshot hex12>" and '#' sorts
 * before every character of a host name, so sorting by `g` is sorting by (group_key, page).
 */

/** What the builder needs to know about a page besides its features and labels. */
export interface PageMeta {
  snapshot_id: `sha256:${string}`;
  /** Registrable domain: the unit of the anti-leakage split. */
  group_key: string;
  /** Stratum for reporting (article, docs, ...). */
  category: string;
}

export interface DatasetSource {
  page: PageMeta;
  features: NodeFeatures;
  labels: NodeLabels;
}

export interface DatasetParams {
  /** Salt of the hash bucket; a number is used as its decimal string. */
  seed: string | number;
  ranges?: SplitRanges;
  /** group_key -> split, wins over the hash (manual override, e.g. a protocol-chosen test domain). */
  overrides?: Record<string, SplitName>;
  group_by?: "group_key" | "group";
  min_confidence?: number;
  /** Label sources accepted in any split. Default: all. */
  allowed_sources?: readonly LabelSource[];
  /** Label sources accepted in the test split (ADR-006: human only). Default ["human"]. */
  test_allowed_sources?: readonly LabelSource[];
  keep_classes?: readonly string[];
  dedupe?: "none" | "exact_x_per_group";
}

export interface BuiltDataset {
  manifest: DatasetManifest;
  /** `manifest.json`, `train.jsonl`, `val.jsonl`, `test.jsonl`. */
  files: Record<string, string>;
  /** Labels whose unit is not a feature row (e.g. prefiltered), per group_id. */
  orphan_labels: Record<string, number>;
}

const SPLITS = ["train", "val", "test"] as const satisfies readonly SplitName[];

export const groupIdOf = (page: PageMeta): string => `${page.group_key}#${page.snapshot_id.slice("sha256:".length, "sha256:".length + 12)}`;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const rate = (pos: number, rows: number): number => (rows === 0 ? 0 : pos / rows);

interface GroupBuild {
  group_id: string;
  page: PageMeta;
  src: DatasetSource;
  split: SplitName;
  bucket: number;
  rows: DatasetRow[];
  orphans: number;
}

export function buildDataset(schema: FeatureSchema, sources: readonly DatasetSource[], params: DatasetParams): BuiltDataset {
  const salt = String(params.seed);
  const ranges = params.ranges ?? DEFAULT_SPLIT_RANGES;
  const groupBy = params.group_by ?? "group_key";
  const overrides = params.overrides ?? {};
  const minConfidence = params.min_confidence ?? 0;
  const allowed = new Set<LabelSource>(params.allowed_sources ?? LABEL_SOURCES);
  const testAllowed = new Set<LabelSource>(params.test_allowed_sources ?? ["human"]);
  const keepClasses = [...(params.keep_classes ?? DEFAULT_KEEP_CLASSES)];
  const dedupe = params.dedupe ?? "none";

  const first = sources[0];
  const space = first?.labels.label_space;
  const projected = space !== undefined && space.kind !== "binary";
  const seenIds = new Set<string>();
  const groups: GroupBuild[] = [];
  for (const src of sources) {
    const { features, labels, page } = src;
    if (features.feature_schema_id !== schema.schema_id) {
      throw new Error(`features ${features.features_id} use schema ${features.feature_schema_id}, not ${schema.schema_id}`);
    }
    if (features.snapshot_id !== page.snapshot_id || labels.snapshot_id !== page.snapshot_id) {
      throw new Error(`features, labels and snapshot of page ${page.snapshot_id} do not refer to the same snapshot`);
    }
    if (JSON.stringify(labels.label_space) !== JSON.stringify(space)) throw new Error("all labels must share one label space");
    const group_id = groupIdOf(page);
    if (seenIds.has(group_id)) throw new Error(`two sources for group ${group_id}: merge the labels of a snapshot first`);
    seenIds.add(group_id);
    const hashed = groupBy === "group_key" ? page.group_key : group_id;
    const { split, bucket } = assignSplit(salt, hashed, { ranges, overrides: groupBy === "group_key" ? overrides : {} });
    const g: GroupBuild = { group_id, page, src, split, bucket, rows: [], orphans: 0 };
    fillRows(g, schema, { projected, keepClasses, minConfidence, allowed, testAllowed, dedupe });
    groups.push(g);
  }
  groups.sort((a, b) => cmp(a.group_id, b.group_id));

  const lines: Record<SplitName, string[]> = { train: [], val: [], test: [] };
  const counts: Record<SplitName, { rows: number; pos: number }> = {
    train: { rows: 0, pos: 0 },
    val: { rows: 0, pos: 0 },
    test: { rows: 0, pos: 0 },
  };
  const strata = new Map<string, { groups: number; rows: number; pos: number }>();
  for (const g of groups) {
    const pos = g.rows.reduce((n, r) => n + r.y, 0);
    counts[g.split].rows += g.rows.length;
    counts[g.split].pos += pos;
    const st = strata.get(g.page.category) ?? { groups: 0, rows: 0, pos: 0 };
    st.groups++;
    st.rows += g.rows.length;
    st.pos += pos;
    strata.set(g.page.category, st);
    for (const r of g.rows) lines[g.split].push(JSON.stringify(r));
  }
  const text = (s: SplitName): string => (lines[s].length === 0 ? "" : `${lines[s].join("\n")}\n`);
  const fileStats = (s: SplitName): DatasetManifest["files"][SplitName] => {
    const t = text(s);
    return {
      path: `${s}.jsonl`,
      sha256: sha256Of(t),
      bytes: Buffer.byteLength(t),
      media_type: "application/x-ndjson",
      rows: counts[s].rows,
      pos_rate: rate(counts[s].pos, counts[s].rows),
    };
  };

  const body = {
    format: "gran-prix.dataset-manifest" as const,
    format_version: "1.0.0" as const,
    feature_schema_id: schema.schema_id,
    dim: schema.dim,
    label_space: projected || space === undefined ? { kind: "binary" as const, classes: [...BINARY_SPACE.classes] as ["drop", "keep"] } : space,
    ...(projected && space ? { label_projection: { from: space, keep_classes: keepClasses } } : {}),
    sources: groups.map((g) => ({
      group_id: g.group_id,
      source_id: g.page.snapshot_id,
      features_id: g.src.features.features_id,
      labels_id: g.src.labels.labels_id,
    })),
    filters: {
      drop_unlabeled: true,
      min_confidence: minConfidence,
      allowed_sources: LABEL_SOURCES.filter((s) => allowed.has(s)),
      test_allowed_sources: LABEL_SOURCES.filter((s) => testAllowed.has(s)),
      dedupe,
    },
    groups: groups.map((g) => ({
      group_id: g.group_id,
      group_key: g.page.group_key,
      stratum: g.page.category,
      split: g.split,
      bucket: g.bucket,
      n_rows: g.rows.length,
      n_pos: g.rows.reduce((n, r) => n + r.y, 0),
    })),
    split: {
      scheme: "hash-bucket-v1" as const,
      group_by: groupBy,
      salt,
      n_buckets: 100 as const,
      ranges: { train: [...ranges.train] as [number, number], val: [...ranges.val] as [number, number], test: [...ranges.test] as [number, number] },
      overrides,
    },
    files: { train: fileStats("train"), val: fileStats("val"), test: fileStats("test") },
    stats: {
      by_split: Object.fromEntries(SPLITS.map((s) => [s, { rows: counts[s].rows, pos_rate: rate(counts[s].pos, counts[s].rows) }])),
      by_stratum: Object.fromEntries(
        [...strata.entries()].sort((a, b) => cmp(a[0], b[0])).map(([k, v]) => [k, { groups: v.groups, rows: v.rows, pos_rate: rate(v.pos, v.rows) }]),
      ),
    },
  };
  const dataset_id = contractId("dataset-manifest", body as unknown as Record<string, unknown>);
  const manifest = { dataset_id, ...body } as DatasetManifest;
  return {
    manifest,
    files: {
      "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
      "train.jsonl": text("train"),
      "val.jsonl": text("val"),
      "test.jsonl": text("test"),
    },
    orphan_labels: Object.fromEntries(groups.filter((g) => g.orphans > 0).map((g) => [g.group_id, g.orphans])),
  };
}

interface RowFilter {
  projected: boolean;
  keepClasses: readonly string[];
  minConfidence: number;
  allowed: ReadonlySet<LabelSource>;
  testAllowed: ReadonlySet<LabelSource>;
  dedupe: "none" | "exact_x_per_group";
}

function fillRows(g: GroupBuild, schema: FeatureSchema, f: RowFilter): void {
  const { features, labels } = g.src;
  const rowOf = new Map<number, number>();
  features.unit_ids.forEach((u, r) => rowOf.set(u, r));
  const seenX = new Set<string>();
  for (const item of labels.items) {
    const r = rowOf.get(item.unit_id);
    if (r === undefined) {
      g.orphans++;
      continue;
    }
    if (item.confidence < f.minConfidence || !f.allowed.has(item.source)) continue;
    if (g.split === "test" && !f.testAllowed.has(item.source)) continue;
    const x = (features.x[r] as number[]).map(Math.fround);
    if (x.length !== schema.dim) throw new Error(`feature row ${r} of ${features.features_id} has ${x.length} values, schema dim is ${schema.dim}`);
    if (f.dedupe === "exact_x_per_group") {
      const key = x.join(",");
      if (seenX.has(key)) continue;
      seenX.add(key);
    }
    const y = f.projected ? projectToBinary(item.y, labels.label_space, f.keepClasses) : item.y;
    const row: DatasetRow = { g: g.group_id, u: item.unit_id, x, y, c: item.confidence, s: item.source };
    if (f.projected) row.l = item.y;
    g.rows.push(row);
  }
  g.rows.sort((a, b) => a.u - b.u);
}
