import { inject, describe, expect, it } from "vitest";
import { assertTruthRules, classIndex, importTruth, labelPageTruth } from "../src/index.js";
import { fixtureNames } from "../src/testing/index.js";
import { loadCorpus } from "./helpers.js";

const corpus = loadCorpus(inject("corpusDir"));

describe("truth importer", () => {
  it("covers every element that owns text on every fixture (the spike's lint)", () => {
    expect(corpus).toHaveLength(fixtureNames().length);
    for (const p of corpus) {
      const imp = importTruth(p.html, p.truth.rules, { url: p.snapshot.page.final_url });
      expect(imp.uncovered, p.name).toEqual([]);
      expect(imp.invalidRules, p.name).toEqual([]);
      expect(imp.deadRules, p.name).toEqual([]);
    }
  });

  it("agrees with the live-page evaluation of the same rules on every element that owns text", () => {
    let checked = 0;
    for (const p of corpus) {
      const imp = importTruth(p.html, p.truth.rules);
      for (const idx of imp.page.ownText.keys()) {
        expect(imp.labels.get(idx), `${p.name} n${idx}`).toBe(p.browserTruth[idx]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it("owns text exactly where the snapshot says so", () => {
    for (const p of corpus) {
      const imp = importTruth(p.html, p.truth.rules);
      const fromSnapshot = p.snapshot.nodes.filter((n) => n.own_text_len > 0).map((n) => n.idx);
      const fromHtml = [...imp.page.ownText.keys()].sort((a, b) => a - b);
      // <title> owns text in the HTML but is document metadata, not a snapshot unit
      expect(fromHtml.filter((i) => imp.page.elements.get(i)?.tagName !== "TITLE"), p.name).toEqual(
        fromSnapshot.filter((i) => p.snapshot.nodes[i]?.tag !== "title"),
      );
    }
  });

  it("nearest ancestor wins, and on the same element the later rule wins", () => {
    const html = `<html data-gp-id="n0"><body data-gp-id="n1"><div data-gp-id="n2" class="a"><p data-gp-id="n3" class="b">x</p><span data-gp-id="n4">y</span></div></body></html>`;
    const imp = importTruth(html, [
      { selector: ".a", label: "support" },
      { selector: "p", label: "main" },
      { selector: ".b", label: "noise" },
    ]);
    expect(imp.labels.get(3)).toBe("noise"); // same element, later rule
    expect(imp.labels.get(4)).toBe("support"); // inherited from the nearest matching ancestor
    expect(imp.labels.get(1)).toBeNull();
    expect(imp.uncovered).toEqual([]);
  });

  it("reports uncovered text, dead rules and invalid selectors instead of guessing", () => {
    const html = `<html data-gp-id="n0"><body data-gp-id="n1"><p data-gp-id="n2">x</p><p data-gp-id="n3" class="z">y</p></body></html>`;
    const imp = importTruth(html, [
      { selector: ".z", label: "main" },
      { selector: ".nothing", label: "noise" },
      { selector: "p[", label: "noise" },
    ]);
    expect(imp.uncovered).toEqual([2]);
    expect(imp.deadRules).toEqual([".nothing"]);
    expect(imp.invalidRules).toEqual(["p["]);
  });

  it("validates rule shapes", () => {
    expect(() => assertTruthRules([{ selector: "p", label: "main" }])).not.toThrow();
    expect(() => assertTruthRules([{ selector: "p", label: "keep" }])).toThrow(/rule 0/);
    expect(() => assertTruthRules({})).toThrow(/array/);
  });

  it("labelPageTruth: human source, 3 classes, aligned to the feature rows that own text", () => {
    const p = corpus[0]!;
    const doc = labelPageTruth(p, p.truth.rules);
    const eligible = p.features.unit_ids.filter((i) => (p.snapshot.nodes[i]?.own_text_len ?? 0) > 0);
    expect(doc.items.map((i) => i.unit_id)).toEqual(eligible);
    expect(doc.items.every((i) => i.source === "human" && i.confidence === 1)).toBe(true);
    expect(doc.label_space.classes).toEqual(["main", "support", "noise"]);
    expect(doc.coverage).toEqual({ n_labeled: eligible.length, n_candidates: eligible.length });
    for (const it of doc.items) expect(it.y).toBe(classIndex(p.browserTruth[it.unit_id] as "main"));
    expect(labelPageTruth(p, p.truth.rules).labels_id).toBe(doc.labels_id); // deterministic
  });

  it("a page without truth yields an empty, honest labels document", () => {
    const p = corpus[0]!;
    const doc = labelPageTruth(p, null);
    expect(doc.items).toEqual([]);
    expect(doc.truth_import).toEqual({ has_rules: false });
  });
});
