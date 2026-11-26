import { describe, expect, inject, it } from "vitest";
import { validate } from "@gran-prix/contracts";
import { eligibleUnits, labelPageExtraction, parseFlattened, type ExtractionLabeler } from "../src/index.js";
import { loadCorpus } from "./helpers.js";

const corpus = loadCorpus(inject("corpusDir"));
const page = (n: string) => corpus.find((p) => p.name === n)!;
const LAB: ExtractionLabeler = { id: "fake-extractor@1", params: { tool: "fake" } };

/** What a perfect-ish extractor returns: the own text of the elements the fixture truth calls main/support, in document order. */
function truthText(name: string): string {
  const p = page(name);
  const flat = parseFlattened(p.html);
  return [...flat.ownText]
    .filter(([idx]) => p.browserTruth[idx] === "main")
    .map(([, t]) => t)
    .join("\n");
}

describe("labelPageExtraction (labels from any extractor's text)", () => {
  it("is contract-valid, 3-class, over the units that own text, with the alignment record and the labeler id", () => {
    const p = page("article-1");
    const doc = labelPageExtraction(p, { text: truthText("article-1") }, LAB, { min_coverage: 0 });
    expect(validate("node-labels", doc).issues).toEqual([]);
    expect(doc.items.map((i) => i.unit_id)).toEqual(eligibleUnits(p.snapshot, p.features));
    expect(doc.labeler).toMatchObject({ id: "fake-extractor@1", kind: "heuristic" });
    expect(doc.label_space).toEqual({ kind: "multiclass", classes: ["main", "support", "noise"] });
    expect(doc.items.every((i) => (i.y === 0 || i.y === 2) && (i.source === "heuristic" || i.source === "rule"))).toBe(true);
    expect(doc["alignment"]).toMatchObject({ status: "ok", discarded: false, min_coverage: 0 });
    expect((doc["alignment"] as { coverage: number }).coverage).toBeGreaterThan(0.95);
  });

  it("keeps the units whose text the extractor returned and drops the rest", () => {
    const p = page("article-1");
    const doc = labelPageExtraction(p, { text: truthText("article-1") }, LAB, { min_coverage: 0, h1_title: false });
    let agree = 0;
    let total = 0;
    for (const it of doc.items) {
      const t = p.browserTruth[it.unit_id];
      if (t === null || t === undefined) continue;
      total++;
      if ((it.y === 0) === (t === "main")) agree++;
    }
    expect(agree / total).toBeGreaterThan(0.9);
  });

  it("the h1 that duplicates the title is main by rule, and h1_title: false switches that off", () => {
    const p = page("article-1");
    const h1 = p.snapshot.nodes.find((n) => n.tag === "h1" && n.own_text_len > 0)!;
    const text = truthText("article-1").split("\n").filter((l) => l !== (parseFlattened(p.html).ownText.get(h1.idx) ?? "")).join("\n");
    const on = labelPageExtraction(p, { text }, LAB, { min_coverage: 0 });
    expect(on.items.find((i) => i.unit_id === h1.idx)).toMatchObject({ y: 0, source: "rule", reason: "rule:h1=title" });
    const off = labelPageExtraction(p, { text }, LAB, { min_coverage: 0, h1_title: false });
    expect(off.items.find((i) => i.unit_id === h1.idx)).toMatchObject({ y: 2, source: "heuristic" });
  });

  it("a blank output: discarded under the default threshold (abstention), all-drop with min_coverage 0 (baseline scoring: F1 0, never 1)", () => {
    const p = page("forum-1");
    const abstain = labelPageExtraction(p, { text: "  \n " }, LAB);
    expect(abstain.items).toEqual([]);
    expect(abstain.coverage).toMatchObject({ n_labeled: 0 });
    expect(abstain["alignment"]).toMatchObject({ status: "no-output", discarded: true });
    const scored = labelPageExtraction(p, { text: null }, LAB, { min_coverage: 0 });
    expect(scored.items.length).toBe(scored.coverage.n_candidates);
    expect(scored.items.every((i) => i.y === 2)).toBe(true);
    expect(scored["alignment"]).toMatchObject({ status: "ok", discarded: false, coverage: 0, output_chars: 0 });
    expect(validate("node-labels", scored).issues).toEqual([]);
  });

  it("text the page does not contain gives low coverage: discarded by default, scored (all drop) with min_coverage 0", () => {
    const p = page("landing-1");
    const alien = "Completely unrelated sentence about nothing on the page whatsoever, repeated for length. ".repeat(6);
    const d = labelPageExtraction(p, { text: alien }, LAB);
    expect(d["alignment"]).toMatchObject({ status: "low-coverage", discarded: true });
    expect((d["alignment"] as { coverage: number }).coverage).toBeLessThan(0.1);
    expect(d.items).toEqual([]);
    const s = labelPageExtraction(p, { text: alien }, LAB, { min_coverage: 0 });
    expect(s["alignment"]).toMatchObject({ discarded: false });
    expect(s.items.every((i) => i.y === 2)).toBe(true);
  });

  it("is deterministic and params are part of the identity (labels_id, params_sha256)", () => {
    const p = page("docs-1");
    const text = truthText("docs-1");
    const a = labelPageExtraction(p, { text }, LAB, { min_coverage: 0 });
    expect(labelPageExtraction(p, { text }, LAB, { min_coverage: 0 })).toEqual(a);
    const b = labelPageExtraction(p, { text }, LAB, { min_coverage: 0, confidence: 0.5 });
    expect(b.labeler.params_sha256).not.toBe(a.labeler.params_sha256);
    expect(b.labels_id).not.toBe(a.labels_id);
    const withExtra = labelPageExtraction(p, { text }, { ...LAB, extra: { extraction: { tool: "fake", version: "1" } } }, { min_coverage: 0 });
    expect(withExtra["extraction"]).toEqual({ tool: "fake", version: "1" });
  });
});

describe("parseFlattened on stylesheets the pinned jsdom cannot parse", () => {
  // Found on a real page of the dom-v0 corpus (a video.js spinner rule). jsdom 27.4 throws while parsing it.
  const CRASH = "a{border:inherit;border-color:transparent}";
  const page = (css: string): string =>
    `<html><head><title>T</title><style>${css}</style></head><body><article><h1 data-gp-id="n0">Title</h1><p data-gp-id="n1">Body text.</p></article></body></html>`;

  it("parses the page with the styles emptied, keeping every element and its text", () => {
    const bad = parseFlattened(page(CRASH), "https://example.test/a");
    const good = parseFlattened(page("a{color:red}"), "https://example.test/a");
    expect([...bad.elements.keys()]).toEqual([...good.elements.keys()]);
    expect(bad.texts.map((t) => t.t)).toEqual(good.texts.map((t) => t.t));
    expect(bad.texts.map((t) => t.t)).toEqual(["Title", "Body text."]);
  });
});
