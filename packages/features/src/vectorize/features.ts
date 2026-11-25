// FeatureSchema v0: the single definition of every feature (name, kind, doc, static transform, range,
// default) and how to compute its raw value. `src/schema/feature-schema.v0.json` is generated from
// this list (test/schema.test.ts regenerates and compares it), and `vectorize` looks features up by
// NAME, taking transform / range / default from the schema it is handed.
import { HINT_NAMES, ID_CLASS_BUCKETS } from "./text.js";
import {
  LM_ASIDE, LM_FOOTER, LM_HEADER, LM_MAIN, LM_NAV, PAGE_ARTICLE, PAGE_DISCUSSION, PAGE_PRODUCT,
  type Ctx,
} from "./derive.js";
import type { ContextRel, FeatureKind, SnapNodeLike, StaticTransformLike } from "./types.js";

/** Returns the raw value, or `null` when the feature does not apply (the schema `default` is used). */
export type RawFn = (c: Ctx, i: number) => number | null;

export interface FeatureSpec {
  name: string;
  kind: FeatureKind;
  group: string;
  doc: string;
  transform: StaticTransformLike;
  range: [number, number];
  default: number;
  onehot?: { of: string; value: string };
  hash?: { fn: "fnv1a32"; buckets: number };
  context?: { rel: ContextRel; source: string };
  /** Absent for context features, which read the finished value of another node's row. */
  raw?: RawFn;
}

const node = (c: Ctx, i: number): SnapNodeLike => c.nodes[i] as SnapNodeLike;
const NONE: StaticTransformLike = { op: "none" };
const UNIT: [number, number] = [0, 1];
const flag = (b: boolean): number => (b ? 1 : 0);

function scalar(name: string, group: string, doc: string, raw: RawFn, opts: Partial<Pick<FeatureSpec, "transform" | "range" | "default">> = {}): FeatureSpec {
  return { name, kind: "scalar", group, doc, transform: opts.transform ?? NONE, range: opts.range ?? UNIT, default: opts.default ?? 0, raw };
}
function boolean(name: string, group: string, doc: string, raw: RawFn): FeatureSpec {
  return { name, kind: "bool", group, doc, transform: NONE, range: UNIT, default: 0, raw };
}
function oneHotTag(value: string, doc: string, match: (tag: string) => boolean): FeatureSpec {
  return {
    name: `tag_${value}`, kind: "onehot", group: "tag", doc, transform: NONE, range: UNIT, default: 0,
    onehot: { of: "tag", value }, raw: (c, i) => flag(match(node(c, i).tag)),
  };
}
function ctxFeature(rel: ContextRel, source: string, doc: string): FeatureSpec {
  return { name: `${rel}_${source}`, kind: "scalar", group: "context", doc, transform: NONE, range: UNIT, default: 0, context: { rel, source } };
}

const TAG_P = new Set(["p"]);
const TAG_DIV = new Set(["div"]);
const TAG_SPAN = new Set(["span"]);
const TAG_A = new Set(["a"]);
const TAG_LI = new Set(["li"]);
const TAG_HEADING = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const TAG_NAMED = new Set([...TAG_P, ...TAG_DIV, ...TAG_SPAN, ...TAG_A, ...TAG_LI, ...TAG_HEADING]);

const hintFeature = (idx: number, name: string): FeatureSpec =>
  boolean(
    `hint_${name}`, "hint",
    `1 when an id/class token of this node or of an ancestor matches the "${name}" hint list (see README).`,
    (c, i) => flag(((c.hints[i] as number) >> idx & 1) === 1),
  );

const hashFeature = (b: number): FeatureSpec => ({
  name: `idclass_hash_${b}`, kind: "hash_bucket", group: "hash",
  doc: `1 when some id/class token of this node alone hashes (FNV-1a 32) to bucket ${b} of ${ID_CLASS_BUCKETS}.`,
  transform: NONE, range: UNIT, default: 0, hash: { fn: "fnv1a32", buckets: ID_CLASS_BUCKETS },
  raw: (c, i) => flag((((c.buckets[i] as number) >> b) & 1) === 1),
});

export const FEATURE_SPECS: readonly FeatureSpec[] = [
  // ---- text (Kohlschuetter / CETD / jusText style) ----
  scalar("log_own_len", "text", "log1p(own_text_len) / log1p(5000): characters of the node's direct text.",
    (c, i) => node(c, i).own_text_len, { transform: { op: "log1p", scale: 5000 } }),
  scalar("log_text_len", "text", "log1p(text_len) / log1p(100000): characters of the whole subtree text.",
    (c, i) => node(c, i).text_len, { transform: { op: "log1p", scale: 100000 } }),
  scalar("own_text_ratio", "text", "own_text_len / text_len: share of the subtree text that is the node's own.",
    (c, i) => { const n = node(c, i); return n.text_len > 0 ? Math.min(n.own_text_len / n.text_len, 1) : 0; }),
  scalar("link_density", "text", "link_text_len / text_len: share of the subtree text inside <a> (Kohlschuetter, CETD).",
    (c, i) => { const n = node(c, i); return n.text_len > 0 ? Math.min(n.link_text_len / n.text_len, 1) : 0; }),
  scalar("text_density", "text", "CETD text density: log1p(text_len / elements in subtree) / log1p(1000).",
    (c, i) => ((c.subtree[i] as number) > 0 ? node(c, i).text_len / (c.subtree[i] as number) : 0), { transform: { op: "log1p", scale: 1000 } }),
  scalar("stopword_ratio", "text", "Stopword-like words / words in the node's own text (cheap multilingual list, jusText style).",
    (c, i) => c.stopwordRatio[i] as number),
  scalar("punct_ratio", "text", "Punctuation characters / characters in the node's own text.",
    (c, i) => c.punctRatio[i] as number),
  scalar("ends_with_punct", "text", "1 when the own text ends with sentence punctuation, 0 when not, 0.5 when the probe truncated it.",
    (c, i) => c.endsWithPunct[i] as number),
  scalar("text_share", "text", "text_len / text_len of the root: the node's share of all text on the page.",
    (c, i) => (c.rootTextLen > 0 ? Math.min(node(c, i).text_len / c.rootTextLen, 1) : 0)),

  // ---- structure ----
  scalar("depth", "structure", "Composed-tree depth / 32 (root = 0).",
    (c, i) => node(c, i).depth, { transform: { op: "div", by: 32 }, range: [0, 2] }),
  scalar("log_sibling_count", "structure", "log1p(non-prefiltered siblings, self included) / log1p(100).",
    (c, i) => c.sibCount[i] as number, { transform: { op: "log1p", scale: 100 } }),
  scalar("sibling_index_rel", "structure", "Rank among the siblings / (siblings - 1); 0 for an only child.",
    (c, i) => ((c.sibCount[i] as number) > 1 ? (c.sibRank[i] as number) / ((c.sibCount[i] as number) - 1) : 0)),
  scalar("sibling_same_tag_ratio", "structure", "Fraction of the other siblings with the same tag (high for repeated cards / list items).",
    (c, i) => c.sibSameTag[i] as number),
  scalar("log_subtree_size", "structure", "log1p(elements in the subtree, self included) / log1p(5000).",
    (c, i) => c.subtree[i] as number, { transform: { op: "log1p", scale: 5000 } }),
  boolean("in_link", "structure", "1 when the node is an <a> or inside one.", (c, i) => c.inLink[i] as number),
  scalar("doc_pos_rel", "structure", "Node index / (node count - 1): relative position in document order.",
    (c, i) => (c.n > 1 ? i / (c.n - 1) : 0)),

  // ---- tag (one-hot of the most common tags plus "other") ----
  oneHotTag("p", "1 for <p>.", (t) => TAG_P.has(t)),
  oneHotTag("div", "1 for <div>.", (t) => TAG_DIV.has(t)),
  oneHotTag("span", "1 for <span>.", (t) => TAG_SPAN.has(t)),
  oneHotTag("a", "1 for <a>.", (t) => TAG_A.has(t)),
  oneHotTag("li", "1 for <li>.", (t) => TAG_LI.has(t)),
  oneHotTag("heading", "1 for <h1> to <h6>.", (t) => TAG_HEADING.has(t)),
  oneHotTag("other", "1 for every other tag.", (t) => !TAG_NAMED.has(t)),

  // ---- landmarks / roles (tag or ARIA role of the node or an ancestor) ----
  boolean("in_main", "landmark", "1 inside <main> or role=main (self or ancestor).", (c, i) => flag(((c.landmark[i] as number) & LM_MAIN) !== 0)),
  boolean("in_nav", "landmark", "1 inside <nav> or role=navigation.", (c, i) => flag(((c.landmark[i] as number) & LM_NAV) !== 0)),
  boolean("in_header", "landmark", "1 inside <header> or role=banner.", (c, i) => flag(((c.landmark[i] as number) & LM_HEADER) !== 0)),
  boolean("in_footer", "landmark", "1 inside <footer> or role=contentinfo.", (c, i) => flag(((c.landmark[i] as number) & LM_FOOTER) !== 0)),
  boolean("in_aside", "landmark", "1 inside <aside> or role=complementary.", (c, i) => flag(((c.landmark[i] as number) & LM_ASIDE) !== 0)),

  // ---- visibility and geometry ----
  boolean("visible", "geometry", "1 when the node has a non-empty box on the canvas, visibility:visible and no opacity:0 ancestor-or-self.",
    (c, i) => c.visible[i] as number),
  scalar("area_frac", "geometry", "Box area / (scroll_w * scroll_h), clipped to [0, 1]; 0 without a box.",
    (c, i) => {
      const r = node(c, i).rect;
      const area = c.doc.scroll_w * c.doc.scroll_h;
      return r !== null && area > 0 ? (r.w * r.h) / area : 0;
    }, { transform: { op: "clip", lo: 0, hi: 1 } }),
  scalar("y_center_rel", "geometry", "Vertical centre of the box / scroll_h, clipped to [0, 1]; 0 without a box.",
    (c, i) => {
      const r = node(c, i).rect;
      return r !== null && c.doc.scroll_h > 0 ? (r.y + r.h / 2) / c.doc.scroll_h : 0;
    }, { transform: { op: "clip", lo: 0, hi: 1 } }),
  scalar("font_size_rel", "geometry", "font_size / median font size of the visible text nodes of the page, clipped to [0, 4].",
    (c, i) => (c.medianFont > 0 ? node(c, i).style.font_size / c.medianFont : 1),
    { transform: { op: "clip", lo: 0, hi: 4 }, range: [0, 4], default: 1 }),
  scalar("font_weight_rel", "geometry", "font_weight / 900.",
    (c, i) => node(c, i).style.font_weight, { transform: { op: "div", by: 900 }, range: [0, 1.25] }),
  boolean("pos_fixed_sticky", "geometry", "1 when computed position is fixed or sticky (headers, banners, modals).",
    (c, i) => { const p = node(c, i).style.position; return flag(p === "fixed" || p === "sticky"); }),

  // ---- id / class hints (explicit tokens, ancestor-or-self) ----
  ...HINT_NAMES.map((h, idx) => hintFeature(idx, h)),

  // ---- id / class token hashing (own tokens) ----
  ...Array.from({ length: ID_CLASS_BUCKETS }, (_, b) => hashFeature(b)),

  // ---- page type (constant over a page) ----
  boolean("page_article", "page", "1 when og:type is article or JSON-LD @type is an Article kind.", (c) => flag((c.pageType & PAGE_ARTICLE) !== 0)),
  boolean("page_product", "page", "1 when og:type is product* or JSON-LD @type is Product / Offer.", (c) => flag((c.pageType & PAGE_PRODUCT) !== 0)),
  boolean("page_discussion", "page", "1 when JSON-LD @type is DiscussionForumPosting / QAPage / Question.", (c) => flag((c.pageType & PAGE_DISCUSSION) !== 0)),

  // ---- context: the finished value of a core feature at the parent / previous / next sibling ----
  ctxFeature("parent", "log_text_len", "log_text_len of the parent (0 for the root)."),
  ctxFeature("parent", "link_density", "link_density of the parent."),
  ctxFeature("parent", "text_density", "text_density of the parent."),
  ctxFeature("prev", "log_text_len", "log_text_len of the previous non-prefiltered sibling (0 when none)."),
  ctxFeature("prev", "link_density", "link_density of the previous sibling."),
  ctxFeature("prev", "text_density", "text_density of the previous sibling."),
  ctxFeature("next", "log_text_len", "log_text_len of the next non-prefiltered sibling (0 when none)."),
  ctxFeature("next", "link_density", "link_density of the next sibling."),
  ctxFeature("next", "text_density", "text_density of the next sibling."),
];

export const FEATURE_BY_NAME: ReadonlyMap<string, FeatureSpec> = new Map(FEATURE_SPECS.map((f) => [f.name, f]));
