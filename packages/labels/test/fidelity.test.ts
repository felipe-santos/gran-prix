// Port fidelity: the jsdom Readability labeler must reproduce the numbers of the spike
// (experiments/spikes/collect-align/FINDINGS.md) on the same 12 fixtures, scored against the truth importer.
// The fixture truth carries the revisions R1-R3 of the annotation guide (2026-11-25); the main-only numbers are the
// historical ones, the main+support constants were re-run on the revised truth (see the note in FINDINGS.md).
import { inject, describe, expect, it } from "vitest";
import { importTruth, readabilityLabel, type ElementDecision, type TruthClass } from "../src/index.js";
import { Counts, loadCorpus, scorePage, type Prf } from "./helpers.js";

const corpus = loadCorpus(inject("corpusDir"));

const MAIN = new Set<TruthClass>(["main"]);
const MAIN_SUPPORT = new Set<TruthClass>(["main", "support"]);

type Method = "rd-attr+shadow" | "rd-text" | "rd-hybrid" | "labeler";
const KEPT: Record<Method, (d: ElementDecision) => boolean> = {
  "rd-attr+shadow": (d) => d.via === "id" || d.via === "id+text",
  "rd-text": (d) => d.via === "text" || d.via === "id+text",
  "rd-hybrid": (d) => d.kept,
  // the labeler as shipped: ids OR text, plus the h1-matches-title rule
  labeler: (d) => d.kept,
};

const runs = (h1Title: boolean) =>
  corpus.map((p) => {
    const res = readabilityLabel(p.html, { url: p.snapshot.page.final_url, h1Title });
    const truth = importTruth(p.html, p.truth.rules, { url: p.snapshot.page.final_url });
    return { p, res, truth };
  });
const spikeRuns = runs(false); // the spike's methods did not have the h1 rule
const shippedRuns = runs(true);

function score(rs: typeof spikeRuns, method: Method, positives: ReadonlySet<TruthClass>, category?: string): Prf {
  const total = new Counts();
  for (const { p, res, truth } of rs) {
    if (category && p.truth.category !== category) continue;
    total.add(
      scorePage(
        res.page.ownText,
        (i) => res.page.elements.get(i)?.tagName ?? "",
        (i) => truth.labels.get(i) ?? null,
        (i) => KEPT[method](res.decisions.get(i) ?? { kept: false, via: null }),
        positives,
      ),
    );
  }
  return total.prf();
}

const fmt = (x: Prf): string => `${x.p.toFixed(1)}/${x.r.toFixed(1)}/${x.f1.toFixed(1)}`;
const near = (got: Prf, want: [number, number, number], tol = 1): void => {
  expect(Math.abs(got.p - want[0]), `precision ${fmt(got)} vs ${want.join("/")}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(got.r - want[1]), `recall ${fmt(got)} vs ${want.join("/")}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(got.f1 - want[2]), `f1 ${fmt(got)} vs ${want.join("/")}`).toBeLessThanOrEqual(tol);
};

describe("port fidelity vs the spike (12 fixtures, char-weighted P/R/F1 %, positive = main)", () => {
  const cats = ["article", "docs", "forum", "landing", "product", "spa"];
  it("prints the table", () => {
    const rows = [...cats, "ALL"].map((c) => {
      const cat = c === "ALL" ? undefined : c;
      return `${c.padEnd(8)} ${(["rd-attr+shadow", "rd-text", "rd-hybrid"] as const).map((m) => fmt(score(spikeRuns, m, MAIN, cat)).padEnd(16)).join(" ")} labeler(+h1) ${fmt(score(shippedRuns, "labeler", MAIN, cat))}`;
    });
    console.log(`category  rd-attr+shadow   rd-text         rd-hybrid        \n${rows.join("\n")}`);
  });

  it("rd-attr+shadow ALL = 81.1/94.2/87.2", () => near(score(spikeRuns, "rd-attr+shadow", MAIN), [81.1, 94.2, 87.2]));
  it("rd-text ALL = 78.6/94.2/85.7", () => near(score(spikeRuns, "rd-text", MAIN), [78.6, 94.2, 85.7]));
  it("rd-hybrid ALL = 78.5/94.2/85.7", () => near(score(spikeRuns, "rd-hybrid", MAIN), [78.5, 94.2, 85.7]));

  // Guide R1-R3 (2026-11-25) moved three fixture rules between support and noise (article-1 "Load more comments",
  // forum-2 votes, product-1 trust badges), so the main+support numbers moved by <= 0.3 points: they were
  // 94.7/85.2/89.7 (rd-attr+shadow) and 93.3/86.6/89.8 (rd-text) with the old truth, and were re-run with the
  // spike on the revised truth. The positive = main numbers above are unchanged by construction.
  it("positive = main + support (truth revised by guide R1-R3): rd-attr+shadow 94.9/85.2/89.8 and rd-text 93.6/86.7/90.0", () => {
    near(score(spikeRuns, "rd-attr+shadow", MAIN_SUPPORT), [94.9, 85.2, 89.8]);
    near(score(spikeRuns, "rd-text", MAIN_SUPPORT), [93.6, 86.7, 90.0]);
  });

  it("per category, rd-text F1 is within 2 points of the spike", () => {
    const want: Record<string, number> = { article: 95.6, docs: 97.1, forum: 83.7, landing: 55.1, product: 67.8, spa: 91.9 };
    for (const c of cats) expect(Math.abs(score(spikeRuns, "rd-text", MAIN, c).f1 - (want[c] as number)), c).toBeLessThanOrEqual(2);
  });

  it("the h1-matches-title rule only adds recall (it never drops a kept element)", () => {
    const before = score(spikeRuns, "rd-hybrid", MAIN);
    const after = score(shippedRuns, "labeler", MAIN);
    expect(after.r).toBeGreaterThan(before.r);
    expect(after.f1).toBeGreaterThanOrEqual(before.f1);
    spikeRuns.forEach(({ res: a }, k) => {
      for (const [i, d] of a.decisions) if (d.kept) expect(shippedRuns[k]?.res.decisions.get(i)?.kept).toBe(true);
    });
  });

  it("every page aligns with coverage >= 90% and is accepted", () => {
    for (const { p, res } of shippedRuns) {
      expect(res.alignment.coverage, p.name).toBeGreaterThanOrEqual(0.9);
      expect(res.status, p.name).toBe("ok");
    }
  });

  it("isProbablyReaderable is true on article/docs/spa and false on forum/landing/product (spike finding)", () => {
    for (const { p, res } of shippedRuns) {
      const want = ["article", "docs", "spa"].includes(p.truth.category);
      expect(res.readerable, p.name).toBe(want);
    }
  });
});
