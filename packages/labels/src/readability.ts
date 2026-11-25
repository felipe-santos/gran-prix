/**
 * Readability labeler on jsdom. Method validated by `experiments/spikes/collect-align`:
 *
 *  1. run Readability on a clone of the flattened, stamped document;
 *  2. an element is KEPT when its `data-gp-id` survives in Readability's output (ids) OR when its text
 *     is aligned to Readability's text (text -> node beam DP, see `align.ts`);
 *  3. the `<h1>` that duplicates the title is main by a deterministic rule (Readability deletes it by
 *     design: 9 of the 17 misses on the spike fixtures);
 *  4. the alignment coverage travels with the result: below ~90% the extractor rewrote the text, and
 *     the caller discards the page (or routes it to another labeler).
 */
import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { alignText, keptElements, normText } from "./align.js";
import { gpIdx, parseFlattened, type FlatPage } from "./dom.js";

export const DEFAULT_MIN_COVERAGE = 0.9;
/** `_headerDuplicatesTitle` in Readability.js deletes a heading whose similarity to the title is above this. */
const TITLE_SIMILARITY = 0.75;

export type KeptVia = "id" | "text" | "id+text" | "h1-title";

export interface ElementDecision {
  kept: boolean;
  /** Why it is kept (null when it is not). */
  via: KeptVia | null;
}

export interface ReadabilityOptions {
  /** URL of the page (only used to resolve relative links inside jsdom). */
  url?: string;
  /** Also keep units rescued by the order-free 2/3 rule (off in the spike's `rd-hybrid`). Default false. */
  fuzzy?: boolean;
  /** Apply the h1-matches-title rule. Default true. */
  h1Title?: boolean;
  /** Coverage below this marks the page as `low-coverage`. Default 0.9. */
  minCoverage?: number;
}

export interface ReadabilityPageResult {
  /** `ok`; `no-article` (Readability returned null); `low-coverage` (alignment under `minCoverage`). */
  status: "ok" | "no-article" | "low-coverage";
  readerable: boolean | null;
  article: { title: string | null; length: number } | null;
  alignment: {
    coverage: number;
    exact_units: number;
    fuzzy_units: number;
    ids_kept: number;
    min_coverage: number;
  };
  /** Decision per element that owns text (all of them, hidden ones included), by snapshot idx. */
  decisions: Map<number, ElementDecision>;
  page: FlatPage;
}

/** Readability's `_textSimilarity`: 1 - (share of B's characters in tokens that A does not have). */
export function textSimilarity(a: string, b: string): number {
  const tokens = (s: string): string[] => s.toLowerCase().split(/\W+/).filter(Boolean);
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const inA = new Set(ta);
  const uniqB = tb.filter((t) => !inA.has(t));
  return 1 - uniqB.join(" ").length / tb.join(" ").length;
}

export function readabilityLabel(html: string, opts: ReadabilityOptions = {}): ReadabilityPageResult {
  const minCoverage = opts.minCoverage ?? DEFAULT_MIN_COVERAGE;
  const page = parseFlattened(html, opts.url);
  const decisions = new Map<number, ElementDecision>();
  const owners = [...page.ownText.keys()].sort((a, b) => a - b);
  const empty = (status: ReadabilityPageResult["status"], readerable: boolean | null): ReadabilityPageResult => {
    for (const o of owners) decisions.set(o, { kept: false, via: null });
    return {
      status,
      readerable,
      article: null,
      alignment: { coverage: 0, exact_units: 0, fuzzy_units: 0, ids_kept: 0, min_coverage: minCoverage },
      decisions,
      page,
    };
  };

  let readerable: boolean | null = null;
  try {
    readerable = isProbablyReaderable(page.doc);
  } catch {
    readerable = null;
  }
  const clone = page.doc.cloneNode(true) as Document;
  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(clone).parse();
  } catch {
    article = null;
  }
  if (!article || !article.content || !article.textContent) return empty("no-article", readerable);

  // ids: every data-gp-id inside Readability's output
  const outDoc = new page.doc.defaultView!.DOMParser().parseFromString(article.content, "text/html");
  const ids = new Set<number>();
  for (const el of Array.from(outDoc.querySelectorAll("[data-gp-id]"))) {
    const i = gpIdx(el);
    if (i !== null) ids.add(i);
  }
  // text: units aligned to Readability's text, lifted to elements
  const al = alignText(page.texts, article.textContent);
  const kept = new Set([...al.exact, ...(opts.fuzzy ? al.fuzzy : [])]);
  const textKept = keptElements(page.texts, kept);

  for (const o of owners) {
    const byId = ids.has(o);
    const byText = textKept.has(o);
    decisions.set(o, { kept: byId || byText, via: byId && byText ? "id+text" : byId ? "id" : byText ? "text" : null });
  }
  if (opts.h1Title !== false) applyH1TitleRule(page, owners, decisions, article.title || page.title);

  return {
    status: al.coverage >= minCoverage ? "ok" : "low-coverage",
    readerable,
    article: { title: article.title ?? null, length: article.length ?? article.textContent.length },
    alignment: {
      coverage: round6(al.coverage),
      exact_units: al.exact.size,
      fuzzy_units: al.fuzzy.size,
      ids_kept: ids.size,
      min_coverage: minCoverage,
    },
    decisions,
    page,
  };
}

/** The first `<h1>` (document order) whose text duplicates the title is main content, kept or not by Readability. */
export function applyH1TitleRule(
  page: FlatPage,
  owners: readonly number[],
  decisions: Map<number, ElementDecision>,
  title: string,
): void {
  if (normText(title) === "") return;
  for (const o of owners) {
    const el = page.elements.get(o);
    if (!el || el.tagName !== "H1") continue;
    const text = page.ownText.get(o) ?? "";
    if (textSimilarity(title, text) <= TITLE_SIMILARITY) continue;
    const d = decisions.get(o);
    if (d && !d.kept) decisions.set(o, { kept: true, via: "h1-title" });
    return;
  }
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
