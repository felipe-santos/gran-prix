import { inject, describe, expect, it } from "vitest";
import { assignSplit, sha256Of, validate, type DatasetRow, type NodeFeatures, type NodeLabels } from "@gran-prix/contracts";
import { buildDataset, labelPageReadability, labelPageTruth, mergeLabels, type DatasetSource } from "../src/index.js";
import { loadCorpus, loadSchema } from "./helpers.js";

const dir = inject("corpusDir");
const corpus = loadCorpus(dir);
const schema = loadSchema(dir);

const meta = (p: (typeof corpus)[number]) => ({
  snapshot_id: p.snapshot.snapshot_id,
  group_key: p.snapshot.page.group_key,
  category: p.snapshot.page.category,
});

/** Pages the human labeled (truth) are merged over Readability; the rest only have Readability labels. */
const HUMAN = new Set(["article-1", "docs-1", "forum-1", "product-1", "spa-1", "landing-1"]);
function sources(): DatasetSource[] {
  return corpus.map((p) => {
    const heur = labelPageReadability(p);
    const labels: NodeLabels = HUMAN.has(p.name) ? mergeLabels([heur, labelPageTruth(p, p.truth.rules)]) : heur;
    return { page: meta(p), features: p.features, labels };
  });
}

/** A salt for which every split has at least one group, and the test split holds a human page AND a heuristic-only page. */
function pickSeed(): string {
  const keysOf = (p: (typeof corpus)[number]) => p.snapshot.page.group_key;
  for (let i = 0; i < 500; i++) {
    const seed = `seed-${i}`;
    const split = (p: (typeof corpus)[number]) => assignSplit(seed, keysOf(p)).split;
    const test = corpus.filter((p) => split(p) === "test");
    if (
      corpus.some((p) => split(p) === "train") &&
      corpus.some((p) => split(p) === "val") &&
      test.some((p) => HUMAN.has(p.name)) &&
      test.some((p) => !HUMAN.has(p.name))
    ) {
      return seed;
    }
  }
  throw new Error("no usable seed in 500 tries");
}
const seed = pickSeed();

const readRows = (text: string): DatasetRow[] =>
  text === "" ? [] : text.trimEnd().split("\n").map((l) => JSON.parse(l) as DatasetRow);

describe("dataset from features + labels of the 12 fixtures", () => {
  const built = buildDataset(schema, sources(), { seed });
  const { manifest, files } = built;
  const rows = {
    train: readRows(files["train.jsonl"] as string),
    val: readRows(files["val.jsonl"] as string),
    test: readRows(files["test.jsonl"] as string),
  };

  it("validates against the contracts: manifest (incl. recomputed dataset_id and buckets) and every row", () => {
    const r = validate("dataset-manifest", manifest);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(JSON.parse(files["manifest.json"] as string)).toEqual(manifest);
    for (const s of ["train", "val", "test"] as const) {
      for (const row of rows[s]) expect(validate("dataset-row", row).issues).toEqual([]);
      const f = manifest.files[s];
      expect(f.rows).toBe(rows[s].length);
      expect(f.sha256).toBe(sha256Of(files[`${s}.jsonl`] as string));
      expect(f.bytes).toBe(Buffer.byteLength(files[`${s}.jsonl`] as string));
    }
    expect(rows.train.length).toBeGreaterThan(0);
    expect(rows.val.length).toBeGreaterThan(0);
    expect(rows.test.length).toBeGreaterThan(0);
  });

  it("splits by domain: no group_key (and no group) is in two splits, and the two article pages stay together", () => {
    const seenIn = new Map<string, string>();
    for (const g of manifest.groups) {
      const prev = seenIn.get(g.group_key);
      if (prev) expect(prev, g.group_key).toBe(g.split);
      seenIn.set(g.group_key, g.split);
    }
    expect(manifest.groups.filter((g) => g.group_key === "news.example")).toHaveLength(2);
    const splitOfG = new Map(manifest.groups.map((g) => [g.group_id, g.split]));
    for (const s of ["train", "val", "test"] as const) for (const row of rows[s]) expect(splitOfG.get(row.g)).toBe(s);
    const rowGroups = (s: "train" | "val" | "test") => new Set(rows[s].map((r) => r.g));
    for (const a of ["train", "val", "test"] as const) {
      for (const b of ["train", "val", "test"] as const) if (a < b) expect([...rowGroups(a)].filter((g) => rowGroups(b).has(g))).toEqual([]);
    }
    expect(manifest.split).toMatchObject({ scheme: "hash-bucket-v1", group_by: "group_key", salt: seed });
  });

  it("keeps only human labels in the test split (ADR-006) and other sources elsewhere", () => {
    expect(manifest.filters.test_allowed_sources).toEqual(["human"]);
    expect(rows.test.every((r) => r.s === "human")).toBe(true);
    const emptyTestGroup = manifest.groups.find((g) => g.split === "test" && g.n_rows === 0);
    expect(emptyTestGroup, "a test group with only heuristic labels contributes no rows").toBeDefined();
    const nonHuman = [...rows.train, ...rows.val].filter((r) => r.s !== "human");
    expect(nonHuman.length).toBeGreaterThan(0);
    expect(new Set(nonHuman.map((r) => r.s))).toContain("readability");
  });

  it("projects 3 classes to binary with keep = main + support, recorded in the manifest, keeping the 3-class label in l", () => {
    expect(manifest.label_space).toEqual({ kind: "binary", classes: ["drop", "keep"] });
    expect(manifest.label_projection).toEqual({
      from: { kind: "multiclass", classes: ["main", "support", "noise"] },
      keep_classes: ["main", "support"],
    });
    const all = [...rows.train, ...rows.val, ...rows.test];
    expect(all.every((r) => r.y === (r.l === 2 ? 0 : 1))).toBe(true);
    expect(all.some((r) => r.l === 1 && r.y === 1)).toBe(true); // support kept
    expect(all.some((r) => r.l === 2 && r.y === 0)).toBe(true);
    const mainOnly = buildDataset(schema, sources(), { seed, keep_classes: ["main"] });
    const rowsMain = [...readRows(mainOnly.files["train.jsonl"] as string), ...readRows(mainOnly.files["val.jsonl"] as string)];
    expect(rowsMain.some((r) => r.l === 1 && r.y === 0)).toBe(true); // support dropped when it is not kept
    expect(mainOnly.manifest.dataset_id).not.toBe(manifest.dataset_id);
  });

  it("joins features and labels per unit: x is the feature row of that unit, rows ordered by (group, page, unit)", () => {
    const featOf = new Map<string, NodeFeatures>(sources().map((s) => [`${s.page.group_key}#${s.page.snapshot_id.slice(7, 19)}`, s.features]));
    const all = [...rows.train, ...rows.val, ...rows.test];
    for (const r of all) {
      const f = featOf.get(r.g)!;
      expect(r.x).toEqual(f.x[f.unit_ids.indexOf(r.u)]);
      expect(r.x).toHaveLength(schema.dim);
    }
    for (const s of ["train", "val", "test"] as const) {
      const keys = rows[s].map((r) => r.g);
      expect(keys).toEqual([...keys].sort()); // groups contiguous and in order
      rows[s].forEach((r, i) => {
        const prev = rows[s][i - 1];
        if (prev && prev.g === r.g) expect(r.u).toBeGreaterThan(prev.u);
      });
    }
    expect(manifest.groups.map((g) => g.group_id)).toEqual([...manifest.groups.map((g) => g.group_id)].sort());
  });

  it("is deterministic: same inputs give the same dataset id and bytes, whatever the source order", () => {
    const again = buildDataset(schema, sources().reverse(), { seed });
    expect(again.manifest.dataset_id).toBe(manifest.dataset_id);
    expect(again.files).toEqual(files);
    expect(buildDataset(schema, sources(), { seed: `${seed}-other` }).manifest.dataset_id).not.toBe(manifest.dataset_id);
  });

  it("applies min_confidence, allowed_sources and exact-x dedupe, recording them in the manifest", () => {
    const strict = buildDataset(schema, sources(), { seed, min_confidence: 0.9 });
    const strictRows = [...readRows(strict.files["train.jsonl"] as string), ...readRows(strict.files["val.jsonl"] as string)];
    expect(strictRows.every((r) => r.c >= 0.9)).toBe(true);
    expect(strictRows.length).toBeLessThan(rows.train.length + rows.val.length);
    expect(strict.manifest.filters.min_confidence).toBe(0.9);
    const humanOnly = buildDataset(schema, sources(), { seed, allowed_sources: ["human"] });
    expect(readRows(humanOnly.files["train.jsonl"] as string).every((r) => r.s === "human")).toBe(true);
    const dedup = buildDataset(schema, sources(), { seed, dedupe: "exact_x_per_group" });
    expect(dedup.manifest.files.train.rows).toBeLessThanOrEqual(manifest.files.train.rows);
    expect(validate("dataset-manifest", dedup.manifest).issues).toEqual([]);
  });

  it("refuses features of another schema and two sources for one snapshot", () => {
    const bad = sources();
    bad[0] = { ...bad[0]!, features: { ...bad[0]!.features, feature_schema_id: `sha256:${"0".repeat(64)}` } };
    expect(() => buildDataset(schema, bad, { seed })).toThrow(/use schema/);
    const dup = [...sources(), sources()[0]!];
    expect(() => buildDataset(schema, dup, { seed })).toThrow(/two sources/);
  });

  it("an empty corpus still produces a valid, empty dataset", () => {
    const empty = buildDataset(schema, [], { seed: 1 });
    expect(validate("dataset-manifest", empty.manifest).issues).toEqual([]);
    expect(empty.manifest.split.salt).toBe("1");
  });

  it("leaves out pages flagged at capture by default and records them in the manifest", () => {
    const src = sources();
    const flagged = src[3]!; // any page
    src[3] = { ...flagged, page: { ...flagged.page, flags: ["captcha", "tiny-dom", "not-a-known-flag"] } };
    const d = buildDataset(schema, src, { seed });
    expect(d.manifest.groups).toHaveLength(manifest.groups.length - 1);
    expect(d.manifest.sources.map((s) => s.source_id)).not.toContain(flagged.page.snapshot_id);
    expect((d.manifest as Record<string, unknown>)["excluded_pages"]).toEqual([{ source_id: flagged.page.snapshot_id, group_key: flagged.page.group_key, flags: ["captcha", "tiny-dom"] }]);
    expect(validate("dataset-manifest", d.manifest).issues).toEqual([]);
    expect((manifest as Record<string, unknown>)["excluded_pages"]).toEqual([]);
    // configurable: other flags only, or none
    expect(buildDataset(schema, src, { seed, exclude_flags: ["paywall"] }).manifest.groups).toHaveLength(manifest.groups.length);
    expect(buildDataset(schema, src, { seed, exclude_flags: [] }).manifest.dataset_id).toBe(manifest.dataset_id);
  });
});
