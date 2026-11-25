/**
 * Page-type router rules (protocol section 7, B4). FIXED IN CODE, chosen a priori and never tuned on test (or
 * dev) data: change them only with a new `impl` version of `label.router`, as a recorded deviation.
 *
 * Two parts:
 *  1. `predictPageType`: JSON-LD `@type` -> `og:type` -> URL rules, in that order, first signal that decides wins.
 *  2. `DEFAULT_ROUTER_TABLE`: which extractor handles each type. A priori choice: the per-type dev F1 table the WCXB
 *     publishes for Readability and Trafilatura (public, not our data: Trafilatura leads on every type), plus
 *     the documented meaning of Trafilatura's modes: `favor_recall` for page types whose content is spread over many
 *     blocks (forum replies, product/landing sections), the default for prose-like pages. Defuddle is only the
 *     fallback. A pipeline that wants the oracle router of B4 (best of B1-B3 per category, chosen in dev) passes its
 *     own `table` and `type_from: "category"`.
 */

export const PAGE_TYPES = ["article", "docs", "forum", "product", "landing", "spa", "unknown"] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export interface PageSignals {
  url: string;
  og_type?: string | undefined;
  jsonld_types?: readonly string[] | undefined;
}

export interface TypePrediction {
  type: PageType;
  /** Which rule decided: `jsonld`, `og:type`, `url` or `none`. */
  signal: "jsonld" | "og:type" | "url" | "none";
  /** The value that matched (an `@type`, the `og:type`, or `<rule name>`). */
  evidence: string | null;
}

/** JSON-LD types per page type. Priority order of the page types when a page has several: forum, product, docs, article, landing. */
const JSONLD: ReadonlyArray<readonly [PageType, ReadonlySet<string>]> = [
  ["forum", new Set(["discussionforumposting", "qapage", "question", "answer", "comment"])],
  ["product", new Set(["product", "productgroup", "individualproduct", "offer", "aggregateoffer"])],
  ["docs", new Set(["techarticle", "apireference", "softwaresourcecode", "howto"])],
  ["article", new Set(["article", "newsarticle", "blogposting", "report", "scholarlyarticle", "review", "liveblogposting", "opinionnewsarticle"])],
  ["landing", new Set(["softwareapplication", "webapplication", "mobileapplication", "service", "organization", "faqpage"])],
];

/** `og:type` values (lowercase) per page type. `website`, `profile` etc. carry no information. */
const OG: ReadonlyArray<readonly [PageType, readonly string[]]> = [
  ["article", ["article"]],
  ["product", ["product", "product.item", "og:product", "product.group", "product:item"]],
];

interface UrlRule {
  type: PageType;
  name: string;
  host?: RegExp;
  path?: RegExp;
}

/** Ordered: the first rule that matches decides. Hosts are matched without a leading `www.`. */
const URL_RULES: readonly UrlRule[] = [
  { type: "forum", name: "forum-host", host: /(^|\.)(reddit\.com|stackoverflow\.com|stackexchange\.com|superuser\.com|serverfault\.com|askubuntu\.com|quora\.com|news\.ycombinator\.com|discourse\.[^.]+\.[^.]+|forum\.[^.]+\.[^.]+|forums\.[^.]+\.[^.]+|community\.[^.]+\.[^.]+)$/ },
  { type: "forum", name: "forum-path", path: /\/(forums?|threads?|topics?|discussions?|questions?|boards?|community|t\/[^/]+)\/[^/]+/i },
  { type: "docs", name: "docs-host", host: /^(docs?|developer|developers|help|support|wiki|api|reference)\.|readthedocs\.io$|\.gitbook\.io$/ },
  { type: "docs", name: "docs-path", path: /\/(docs?|documentation|reference|api|guides?|manual|tutorials?|handbook|wiki|man|learn|help|kb|knowledge-?base)(\/|$)/i },
  { type: "product", name: "product-path", path: /\/(products?|p|dp|item|items|shop|store|buy|sku|catalog)\/[^/]+/i },
  { type: "article", name: "article-path", path: /\/(blog|news|articles?|posts?|stor(?:y|ies)|insights|press|magazine|opinion|editorial|journal)\/[^/]+|\/(19|20)\d\d\/(0?[1-9]|1[0-2])\//i },
  { type: "landing", name: "landing-path", path: /^\/(?:pricing|features|solutions|platform|services|product|plans|enterprise)?\/?$/i },
];

const stripType = (t: string): string => t.trim().replace(/^https?:\/\/schema\.org\//i, "").replace(/^schema:/i, "").toLowerCase();

function hostAndPath(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase().replace(/^www\./, ""), path: u.pathname };
  } catch {
    return { host: "", path: url };
  }
}

/** Predicts the page type from structured data and the URL only (never from the page text or from any label). */
export function predictPageType(s: PageSignals): TypePrediction {
  const types = (s.jsonld_types ?? []).map(stripType);
  for (const [type, set] of JSONLD) {
    const hit = types.find((t) => set.has(t));
    if (hit !== undefined) return { type, signal: "jsonld", evidence: hit };
  }
  const og = (s.og_type ?? "").trim().toLowerCase();
  for (const [type, values] of OG) if (og !== "" && values.includes(og)) return { type, signal: "og:type", evidence: og };
  const { host, path } = hostAndPath(s.url);
  for (const r of URL_RULES) {
    if ((r.host && r.host.test(host)) || (r.path && r.path.test(path))) return { type: r.type, signal: "url", evidence: r.name };
  }
  return { type: "unknown", signal: "none", evidence: null };
}

export type ExtractorName = "trafilatura" | "defuddle" | "readability";

export interface ExtractorChoice {
  extractor: ExtractorName;
  /** Trafilatura mode (only for `trafilatura`). */
  mode?: "precision" | "default" | "recall";
}

export const DEFAULT_ROUTER_TABLE: Readonly<Record<PageType, ExtractorChoice>> = {
  article: { extractor: "trafilatura", mode: "default" },
  docs: { extractor: "trafilatura", mode: "default" },
  forum: { extractor: "trafilatura", mode: "recall" },
  product: { extractor: "trafilatura", mode: "recall" },
  landing: { extractor: "trafilatura", mode: "recall" },
  spa: { extractor: "trafilatura", mode: "recall" },
  unknown: { extractor: "trafilatura", mode: "default" },
};

/** Fixed order in which the router falls back when the chosen extractor returns nothing usable (or aligns below `min_coverage`). */
export const FALLBACK_ORDER: readonly ExtractorChoice[] = [
  { extractor: "trafilatura", mode: "default" },
  { extractor: "defuddle" },
  { extractor: "readability" },
];

