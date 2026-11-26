// QA tool, the automatic validators (protocol 9) and the unit map they stand on: positive and negative cases of each.
import { collapse, parseFlattened } from "@gran-prix/labels";
import { htmlToMarkdown, type NodeLike } from "@gran-prix/markdown";
import { describe, expect, it } from "vitest";
import { LocateMismatch, anchoredPrefix, locateUnits, stripMarkers, unitsTouching } from "../src/stages/qa/locate.js";
import type { RawCandidate } from "../src/stages/qa/prompts.js";
import { checkCandidate, goldClassMap, type GoldClass, type ValidationContext } from "../src/stages/qa/validators.js";

/** A node table for a flattened html whose elements carry data-gp-id (the same join the converter uses). */
function nodesFromHtml(html: string): NodeLike[] {
  const flat = parseFlattened(html);
  const out: NodeLike[] = [];
  const parentOf = (el: Element): number => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const id = p.getAttribute("data-gp-id");
      if (id) return Number(id.slice(1));
    }
    return -1;
  };
  for (const [idx, el] of [...flat.elements].sort((a, b) => a[0] - b[0])) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue ?? "").join("");
    out[idx] = { idx, parent: parentOf(el), tag: el.tagName.toLowerCase(), own_text_len: collapse(own).length, style: { display: "block", visibility: "visible", opacity: 1 }, rect: { x: 0, y: idx * 20, w: 400, h: 18 }, flags: {} };
  }
  return out;
}

const PAGE = `<!DOCTYPE html><html data-gp-id="n0"><head data-gp-id="n1"><title data-gp-id="n2">T</title></head><body data-gp-id="n3">
<main data-gp-id="n4"><h1 data-gp-id="n5">Widget Pro</h1>
<p data-gp-id="n6">The widget costs <a data-gp-id="n7" href="/buy">fifty</a> dollars today.</p>
<p data-gp-id="n8">1. Install the widget first.</p>
<p data-gp-id="n9">- not a list, just a dash</p></main>
<footer data-gp-id="n10"><p data-gp-id="n11">Posted by Jane on 2025-01-02</p><p data-gp-id="n12">Accept all cookies</p></footer></body></html>`;

describe("the unit map (locate)", () => {
  const nodes = nodesFromHtml(PAGE);
  const loc = locateUnits(PAGE, nodes);

  it("the clean markdown is exactly the D2 of the page", () => {
    expect(loc.markdown).toBe(htmlToMarkdown(PAGE, nodes).markdown);
    expect(loc.markdown).toContain("The widget costs [fifty](/buy) dollars today.");
  });

  it("a quote touches the elements whose text it overlaps, inline links included", () => {
    const q = "widget costs [fifty](/buy) dollars";
    const at = loc.markdown.indexOf(q);
    expect(at).toBeGreaterThan(0);
    expect(unitsTouching(loc.spans, at, at + q.length)).toEqual([6, 7]);
    const t = "Posted by Jane";
    const a = loc.markdown.indexOf(t);
    expect(unitsTouching(loc.spans, a, a + t.length)).toEqual([11]);
    const w = "Widget Pro";
    const b = loc.markdown.indexOf(w);
    expect(unitsTouching(loc.spans, b, b + w.length)).toEqual([5]);
  });

  it("text that turndown escapes at the start of a text node (1. , -, #) still maps and still equals D2", () => {
    const at = loc.markdown.indexOf("Install the widget first");
    expect(unitsTouching(loc.spans, at, at + 24)).toEqual([8]);
    const d = loc.markdown.indexOf("not a list");
    expect(unitsTouching(loc.spans, d, d + 10)).toEqual([9]);
    for (const text of ["# hash start", "> quote start", "+ plus start", "=== equals", "~~~ tilde"]) {
      const html = `<!DOCTYPE html><html data-gp-id="n0"><body data-gp-id="n1"><p data-gp-id="n2">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p></body></html>`;
      const n = nodesFromHtml(html);
      expect(locateUnits(html, n).markdown, text).toBe(htmlToMarkdown(html, n).markdown);
    }
  });

  it("anchoredPrefix measures what turndown's anchored escapes look at", () => {
    expect(anchoredPrefix("1. step")).toBe(3);
    expect(anchoredPrefix("## title")).toBe(3);
    expect(anchoredPrefix("-x")).toBe(1);
    expect(anchoredPrefix("plain")).toBe(0);
  });

  it("stripMarkers records one span per marked text and drops the markers from the text", () => {
    const m = stripMarkers("ab7cdef12gh");
    expect(m.markdown).toBe("abcdefgh");
    expect(m.spans).toEqual([{ unit: 7, start: 2, end: 4 }, { unit: 12, start: 6, end: 8 }]);
  });

  it("a page that already contains the marker characters is refused, never guessed at", () => {
    const html = '<!DOCTYPE html><html data-gp-id="n0"><body data-gp-id="n1"><p data-gp-id="n2">a\uFDD0b</p></body></html>';
    expect(() => locateUnits(html, nodesFromHtml(html))).toThrow(LocateMismatch);
    expect(() => locateUnits(html, nodesFromHtml(html))).toThrow(/marker characters/);
  });
});

describe("the automatic validators", () => {
  const nodes = nodesFromHtml(PAGE);
  const loc = locateUnits(PAGE, nodes);
  const gold = new Map<number, GoldClass>([[5, "main"], [6, "main"], [7, "main"], [8, "main"], [9, "noise"], [11, "support"], [12, "noise"]]);
  const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({ d2: loc.markdown, spans: loc.spans, gold, seenQuestions: new Set(), minQuoteChars: 8, maxQuoteChars: 200, ...over });
  const cand = (over: Partial<RawCandidate> = {}): RawCandidate => ({ kind: "main", question: "How much does the widget cost today?", answer: "fifty", answer_variants: ["50"], evidence_quote: "The widget costs [fifty](/buy) dollars today.", ...over });

  it("accepts a candidate whose quote is unique and whose elements are main", () => {
    const r = checkCandidate(cand(), ctx());
    expect(r.status).toBe("pass");
    expect(r.evidence).toMatchObject({ unit_ids: [6, 7], class: "main", unit_classes: ["main", "main"] });
    expect(r.advisory).toEqual([]);
  });

  it("the quote must occur exactly once: missing and repeated are different rejections", () => {
    expect(checkCandidate(cand({ evidence_quote: "The widget costs sixty dollars today." }), ctx()).reasons).toContain("quote_not_found");
    const twice = "x ".repeat(3);
    expect(checkCandidate(cand({ evidence_quote: "widget" }), ctx({ d2: `${loc.markdown}\n${twice}widget` })).reasons).toContain("quote_not_unique");
    expect(checkCandidate(cand({ evidence_quote: "the widget costs" }), ctx()).reasons).toContain("quote_not_found"); // literal: case counts
  });

  it("evidence in noise is forbidden, whatever the kind", () => {
    for (const kind of ["main", "category", "support"] as const) {
      const r = checkCandidate(cand({ kind, evidence_quote: "Accept all cookies", question: "What does the banner offer?", answer: "everything" }), ctx());
      expect(r.status, kind).toBe("reject");
      expect(r.reasons, kind).toContain("evidence_in_noise");
    }
    const mixed = checkCandidate(cand({ kind: "category", evidence_quote: "Posted by Jane on 2025-01-02\n\nAccept all cookies" }), ctx());
    expect(mixed.reasons).toContain("evidence_in_noise");
  });

  it("the gold class must fit the kind: main needs main, support needs support, category takes either", () => {
    const support = { kind: "support" as const, evidence_quote: "Posted by Jane on 2025-01-02", question: "Who posted this?", answer: "Jane", answer_variants: [] };
    expect(checkCandidate(cand(support), ctx()).status).toBe("pass");
    expect(checkCandidate(cand({ ...support, kind: "main" }), ctx()).reasons).toContain("kind_class_mismatch");
    expect(checkCandidate(cand({ ...support, kind: "category" }), ctx()).status).toBe("pass");
    expect(checkCandidate(cand({ ...support, kind: "category" }), ctx()).evidence?.class).toBe("support");
    expect(checkCandidate(cand({ kind: "support" }), ctx()).reasons).toContain("kind_class_mismatch");
    // main + support evidence in one quote: neither pure kind accepts it
    const both = "Widget Pro";
    expect(checkCandidate(cand({ kind: "support", evidence_quote: both, question: "Title?", answer: "x" }), ctx()).reasons).toContain("kind_class_mismatch");
  });

  it("an element with no gold label cannot be judged", () => {
    const r = checkCandidate(cand(), ctx({ gold: new Map([[6, "main"]]) }));
    expect(r.reasons).toContain("unit_without_gold");
  });

  it("the question must not contain the answer or a variant (whole words)", () => {
    expect(checkCandidate(cand({ question: "Is the price fifty dollars?" }), ctx()).reasons).toContain("question_contains_answer");
    expect(checkCandidate(cand({ question: "Does it cost 50 dollars?" }), ctx()).reasons).toContain("question_contains_answer"); // the variant
    expect(checkCandidate(cand({ answer: "5", answer_variants: [], question: "Is it 15 or more?" }), ctx()).reasons).not.toContain("question_contains_answer");
  });

  it("hygiene: stubs, pages, markup-only quotes and repeated questions are rejected", () => {
    expect(checkCandidate(cand({ evidence_quote: "dollars" }), ctx()).reasons).toContain("quote_too_short");
    expect(checkCandidate(cand(), ctx({ maxQuoteChars: 10 })).reasons).toContain("quote_too_long");
    expect(checkCandidate(cand({ evidence_quote: "](/buy)" }), ctx({ minQuoteChars: 3 })).reasons).toContain("no_unit");
    const c = ctx();
    expect(checkCandidate(cand(), c).status).toBe("pass");
    expect(checkCandidate(cand({ answer: "dollars" }), c).reasons).toContain("duplicate_question"); // same question again
  });

  it("an answer that is not in the quote is advisory, not a rejection", () => {
    const r = checkCandidate(cand({ answer: "sixty", answer_variants: [] }), ctx());
    expect(r.status).toBe("pass");
    expect(r.advisory).toEqual(["answer_not_in_quote"]);
  });

  it("gold classes come from a 3-class label space only", () => {
    const base = { format: "gran-prix.node-labels", snapshot_id: "sha256:" + "a".repeat(64) } as never;
    const doc = { ...(base as object), label_space: { kind: "multiclass", classes: ["main", "support", "noise"] }, items: [{ unit_id: 3, y: 2 }, { unit_id: 4, y: 0 }] } as never;
    expect([...goldClassMap(doc)]).toEqual([[3, "noise"], [4, "main"]]);
    const binary = { ...(base as object), label_space: { kind: "binary", classes: ["drop", "keep"] }, items: [] } as never;
    expect(() => goldClassMap(binary)).toThrow(/3-class/);
  });
});
