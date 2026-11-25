import { inject, describe, expect, it } from "vitest";
import { validate } from "@gran-prix/contracts";
import {
  NodeFeaturesSetReader,
  SnapshotSetReader,
  eligibleUnits,
  indexBySnapshot,
  labelPageReadability,
  readSetDocs,
  readabilityLabel,
  textSimilarity,
} from "../src/index.js";
import { readTree } from "../src/testing/index.js";
import { loadCorpus } from "./helpers.js";

const dir = inject("corpusDir");
const corpus = loadCorpus(dir);
const byName = (n: string) => corpus.find((p) => p.name === n)!;

describe("Readability labels of a page", () => {
  it("run on contract-valid snapshots and features of the collect layout", () => {
    for (const p of corpus) {
      expect(validate("page-snapshot", p.snapshot).issues, p.name).toEqual([]);
      expect(validate("node-features", p.features).issues, p.name).toEqual([]);
    }
  });

  it("are contract-valid 3-class labels over the feature rows that own text, with the alignment record", () => {
    for (const p of corpus) {
      const doc = labelPageReadability(p);
      expect(validate("node-labels", doc).issues, p.name).toEqual([]);
      const eligible = eligibleUnits(p.snapshot, p.features);
      expect(eligible.length, p.name).toBeGreaterThan(0);
      expect(doc.items.map((i) => i.unit_id), p.name).toEqual(eligible);
      expect(doc.snapshot_id).toBe(p.snapshot.snapshot_id);
      expect(doc.label_space).toEqual({ kind: "multiclass", classes: ["main", "support", "noise"] });
      expect(doc.items.every((i) => i.y === 0 || i.y === 2), p.name).toBe(true); // main or noise only
      expect(doc.items.every((i) => i.source === "readability" || i.source === "rule")).toBe(true);
      expect(doc["alignment"]).toMatchObject({ status: "ok", discarded: false });
      expect((doc["alignment"] as { coverage: number }).coverage).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("marks the h1 that duplicates the title as main by rule (source rule, confidence 0.95)", () => {
    const p = byName("article-1");
    const doc = labelPageReadability(p);
    const h1 = p.snapshot.nodes.find((n) => n.tag === "h1" && n.own_text_len > 0)!;
    const it = doc.items.find((i) => i.unit_id === h1.idx)!;
    expect(it).toMatchObject({ y: 0, source: "rule", confidence: 0.95, reason: "rule:h1=title" });
    const off = labelPageReadability(p, { h1_title: false });
    expect(off.items.find((i) => i.unit_id === h1.idx)?.source).toBe("readability");
  });

  it("discards the page's labels when the alignment coverage is under the threshold, and says so", () => {
    const p = byName("forum-1");
    const doc = labelPageReadability(p, { min_coverage: 1.01 });
    expect(doc.items).toEqual([]);
    expect(doc.coverage.n_labeled).toBe(0);
    expect(doc["alignment"]).toMatchObject({ status: "low-coverage", discarded: true, min_coverage: 1.01 });
    expect(validate("node-labels", doc).issues).toEqual([]);
  });

  it("reports no-article when Readability returns nothing", () => {
    const res = readabilityLabel(`<html data-gp-id="n0"><head data-gp-id="n1"></head><body data-gp-id="n2"></body></html>`);
    expect(res.status).toBe("no-article");
    expect(res.article).toBeNull();
  });

  it("is deterministic and keyed by its params", () => {
    const p = byName("docs-1");
    expect(labelPageReadability(p).labels_id).toBe(labelPageReadability(p).labels_id);
    expect(labelPageReadability(p, { confidence: 0.6 }).labels_id).not.toBe(labelPageReadability(p).labels_id);
  });

  it("refuses features of another snapshot", () => {
    const a = byName("docs-1");
    const b = byName("docs-2");
    expect(() => labelPageReadability({ ...a, features: b.features })).toThrow(/belong to snapshot/);
  });

  it("textSimilarity is Readability's token measure", () => {
    expect(textSimilarity("The Great Title", "the great title")).toBe(1);
    expect(textSimilarity("Great Title", "Great Title Extra")).toBeLessThan(1);
    expect(textSimilarity("", "x")).toBe(0);
  });
});

describe("snapshot and features sets (the readers the collect stage shares)", () => {
  const snapSet = readTree(dir, "snapshot-set");
  const featSet = readTree(dir, "features-set");
  const source = (set: Record<string, Uint8Array>) => ({ file: (p: string) => set[p] as Uint8Array });
  const snaps = new SnapshotSetReader(source(snapSet));
  const feats = new NodeFeaturesSetReader(source(featSet));

  it("follow the manifest: one entry per page, the snapshot, its flattened html and its features", () => {
    expect(snaps.entries()).toHaveLength(12);
    expect(feats.entries().map((e) => e.snapshot_id)).toEqual(snaps.entries().map((e) => e.snapshot_id));
    const e = snaps.entries().find((x) => x.snapshot_id === byName("docs-1").snapshot.snapshot_id)!;
    expect(snaps.snapshot(e)).toEqual(byName("docs-1").snapshot);
    const html = snaps.html(e);
    expect(html).toContain('data-gp-id="n0"');
    expect(html).not.toMatch(/<script[^>]+(src|type)=/i); // scripts are kept but emptied
    expect(html).toBe(byName("docs-1").html);
    const fe = feats.entries().find((x) => x.snapshot_id === e.snapshot_id)!;
    expect(feats.features(fe)).toEqual(byName("docs-1").features);
    expect(fe).toMatchObject({ features_id: byName("docs-1").features.features_id, group_key: e.group_key, stratum: e.stratum });
  });

  it("refuse a set whose manifest is not theirs", () => {
    expect(() => new SnapshotSetReader(source(featSet)).manifest()).toThrow(/not a SnapshotSet/);
    expect(() => new NodeFeaturesSetReader(source(snapSet)).manifest()).toThrow(/not a NodeFeaturesSet/);
  });

  it("report a member the manifest names but the set lacks", () => {
    const { ["snapshots/" + byName("docs-1").snapshot.snapshot_id.slice(7) + ".json"]: _gone, ...rest } = snapSet;
    const reader = new SnapshotSetReader({
      file: (p: string) => {
        const b = rest[p];
        if (!b) throw new Error(`ENOENT ${p}`);
        return b;
      },
    });
    const e = reader.entries().find((x) => x.snapshot_id === byName("docs-1").snapshot.snapshot_id)!;
    expect(() => reader.snapshot(e)).toThrow(/ENOENT/);
  });
});

describe("NodeLabelsSet documents", () => {
  const doc = { format: "gran-prix.node-labels", snapshot_id: "sha256:1" };
  const none = { files: () => [], file: () => new Uint8Array() };

  it("are found by their format, wherever they are; a JSON artifact holds one document or an array", () => {
    expect(readSetDocs({ ...none, json: () => doc }, "gran-prix.node-labels")).toHaveLength(1);
    expect(readSetDocs({ ...none, json: () => [doc, doc] }, "gran-prix.node-labels")).toHaveLength(2);
    expect(readSetDocs({ ...none, json: () => { throw new Error("empty"); } }, "gran-prix.node-labels")).toEqual([]);
    const set: Record<string, Uint8Array> = {
      "labels/a.json": new TextEncoder().encode(JSON.stringify(doc)),
      "labels/b.json": new TextEncoder().encode(JSON.stringify({ format: "other" })),
      "labels/c.txt": new TextEncoder().encode("not json"),
    };
    const members = readSetDocs({ files: () => Object.keys(set), file: (p: string) => set[p] as Uint8Array, json: () => null }, "gran-prix.node-labels");
    expect(members.map((m) => m.path)).toEqual(["labels/a.json"]);
  });

  it("indexBySnapshot refuses two documents for one snapshot", () => {
    const a = { path: "a.json", doc: { snapshot_id: "sha256:1" } };
    expect(indexBySnapshot([a], "NodeLabels").get("sha256:1")).toBe(a);
    expect(() => indexBySnapshot([a, { ...a, path: "b.json" }], "NodeLabels")).toThrow(/two NodeLabels documents/);
  });
});
