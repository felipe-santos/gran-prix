import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inject, describe, expect, it } from "vitest";
import { sha256Of, validate, type FileRef } from "@gran-prix/contracts";
import { eligibleUnits, labelPageReadability, loadSnapshotHtml, readSetDocs, readabilityLabel, textSimilarity } from "../src/index.js";
import { readTree } from "../src/testing/index.js";
import { loadCorpus } from "./helpers.js";

const dir = inject("corpusDir");
const corpus = loadCorpus(dir);
const byName = (n: string) => corpus.find((p) => p.name === n)!;

describe("Readability labels of a page", () => {
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

describe("snapshot sets", () => {
  const set = readTree(dir, "snapshots");
  const files = { files: () => Object.keys(set), file: (p: string) => set[p] as Uint8Array };

  it("finds members by their format, wherever they are, and loads the gzipped HTML next to them", () => {
    const members = readSetDocs<{ snapshot_id: string; html: FileRef }>({ ...files, json: () => null }, "gran-prix.page-snapshot");
    expect(members).toHaveLength(12);
    const m = members.find((x) => x.path === "docs-1/snapshot.json")!;
    const html = loadSnapshotHtml(files, m.path, m.doc.html);
    expect(html).toContain('data-gp-id="n0"');
    expect(html).not.toMatch(/<script/i);
    expect(html).toBe(byName("docs-1").html);
  });

  it("accepts a JSON artifact holding one document or an array", () => {
    const doc = byName("docs-1").features;
    const none = { files: () => [], file: () => new Uint8Array() };
    expect(readSetDocs({ ...none, json: () => doc }, "gran-prix.node-features")).toHaveLength(1);
    expect(readSetDocs({ ...none, json: () => [doc, doc] }, "gran-prix.node-features")).toHaveLength(2);
    expect(readSetDocs({ ...none, json: () => { throw new Error("empty"); } }, "gran-prix.node-features")).toEqual([]);
  });

  it("checks the FileRef hash and reports a missing file", () => {
    const m = readSetDocs<{ html: FileRef }>({ ...files, json: () => null }, "gran-prix.page-snapshot").find((x) => x.path === "docs-1/snapshot.json")!;
    expect(() => loadSnapshotHtml(files, m.path, { ...m.doc.html, sha256: sha256Of("other") })).toThrow(/does not match/);
    expect(() => loadSnapshotHtml(files, m.path, { ...m.doc.html, path: "nope.gz" })).toThrow(/not in the SnapshotSet/);
    // the hash of the DECODED html is accepted too
    const raw = readFileSync(join(dir, "snapshots", "docs-1", "page.html.gz"));
    expect(raw.length).toBeGreaterThan(0);
    expect(loadSnapshotHtml(files, m.path, { ...m.doc.html, sha256: sha256Of(byName("docs-1").html) })).toBe(byName("docs-1").html);
  });
});
