// Raw feature columns, written as plain loops over the rows (G5 performance: the page runs this once, cold, and a closure
// call per cell and feature is what a cold JIT pays most for). `fillRawColumn(name, ...)` computes the same numbers as
// `FeatureSpec.raw` of features.ts, which stays the definition: test/columns.test.ts compares the two on every feature
// of FeatureSchema v0 over real and random snapshots. A feature this file does not know is left to `spec.raw`.
import { HINT_NAMES } from "./text.js";
import { LM_ASIDE, LM_FOOTER, LM_HEADER, LM_MAIN, LM_NAV, PAGE_ARTICLE, PAGE_DISCUSSION, PAGE_PRODUCT, type Ctx } from "./derive.js";
import type { SnapNodeLike } from "./types.js";

const TAG_HEADING = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const TAG_NAMED = new Set(["p", "div", "span", "a", "li", "h1", "h2", "h3", "h4", "h5", "h6"]);

/** Same-tag matchers of the one-hot features, by feature name. */
const TAG_FEATURES = new Map<string, (tag: string) => boolean>(Object.entries({
  tag_p: (t) => t === "p",
  tag_div: (t) => t === "div",
  tag_span: (t) => t === "span",
  tag_a: (t) => t === "a",
  tag_li: (t) => t === "li",
  tag_heading: (t) => TAG_HEADING.has(t),
  tag_other: (t) => !TAG_NAMED.has(t),
}));

const LANDMARK_FEATURES = new Map<string, number>(Object.entries({ in_main: LM_MAIN, in_nav: LM_NAV, in_header: LM_HEADER, in_footer: LM_FOOTER, in_aside: LM_ASIDE }));
const PAGE_FEATURES = new Map<string, number>(Object.entries({ page_article: PAGE_ARTICLE, page_product: PAGE_PRODUCT, page_discussion: PAGE_DISCUSSION }));

/** Fills `out[r]` with the raw value of feature `name` for row r (node `rows[r]`). False when the feature is not known here. */
export function fillRawColumn(name: string, c: Ctx, rows: readonly number[], out: Float64Array): boolean {
  const nodes = c.nodes;
  const n = rows.length;
  switch (name) {
    // ---- text
    case "log_own_len": for (let r = 0; r < n; r++) out[r] = (nodes[rows[r] as number] as SnapNodeLike).own_text_len; return true;
    case "log_text_len": for (let r = 0; r < n; r++) out[r] = (nodes[rows[r] as number] as SnapNodeLike).text_len; return true;
    case "own_text_ratio":
      for (let r = 0; r < n; r++) { const nd = nodes[rows[r] as number] as SnapNodeLike; out[r] = nd.text_len > 0 ? Math.min(nd.own_text_len / nd.text_len, 1) : 0; }
      return true;
    case "link_density":
      for (let r = 0; r < n; r++) { const nd = nodes[rows[r] as number] as SnapNodeLike; out[r] = nd.text_len > 0 ? Math.min(nd.link_text_len / nd.text_len, 1) : 0; }
      return true;
    case "text_density":
      for (let r = 0; r < n; r++) { const i = rows[r] as number; const s = c.subtree[i] as number; out[r] = s > 0 ? (nodes[i] as SnapNodeLike).text_len / s : 0; }
      return true;
    case "stopword_ratio": for (let r = 0; r < n; r++) out[r] = c.stopwordRatio[rows[r] as number] as number; return true;
    case "punct_ratio": for (let r = 0; r < n; r++) out[r] = c.punctRatio[rows[r] as number] as number; return true;
    case "ends_with_punct": for (let r = 0; r < n; r++) out[r] = c.endsWithPunct[rows[r] as number] as number; return true;
    case "text_share":
      for (let r = 0; r < n; r++) out[r] = c.rootTextLen > 0 ? Math.min((nodes[rows[r] as number] as SnapNodeLike).text_len / c.rootTextLen, 1) : 0;
      return true;
    // ---- structure
    case "depth": for (let r = 0; r < n; r++) out[r] = (nodes[rows[r] as number] as SnapNodeLike).depth; return true;
    case "log_sibling_count": for (let r = 0; r < n; r++) out[r] = c.sibCount[rows[r] as number] as number; return true;
    case "sibling_index_rel":
      for (let r = 0; r < n; r++) { const i = rows[r] as number; const k = c.sibCount[i] as number; out[r] = k > 1 ? (c.sibRank[i] as number) / (k - 1) : 0; }
      return true;
    case "sibling_same_tag_ratio": for (let r = 0; r < n; r++) out[r] = c.sibSameTag[rows[r] as number] as number; return true;
    case "log_subtree_size": for (let r = 0; r < n; r++) out[r] = c.subtree[rows[r] as number] as number; return true;
    case "in_link": for (let r = 0; r < n; r++) out[r] = c.inLink[rows[r] as number] as number; return true;
    case "doc_pos_rel": for (let r = 0; r < n; r++) out[r] = c.n > 1 ? (rows[r] as number) / (c.n - 1) : 0; return true;
    // ---- geometry
    case "visible": for (let r = 0; r < n; r++) out[r] = c.visible[rows[r] as number] as number; return true;
    case "area_frac": {
      const area = c.doc.scroll_w * c.doc.scroll_h;
      for (let r = 0; r < n; r++) { const rect = (nodes[rows[r] as number] as SnapNodeLike).rect; out[r] = rect !== null && area > 0 ? (rect.w * rect.h) / area : 0; }
      return true;
    }
    case "y_center_rel":
      for (let r = 0; r < n; r++) { const rect = (nodes[rows[r] as number] as SnapNodeLike).rect; out[r] = rect !== null && c.doc.scroll_h > 0 ? (rect.y + rect.h / 2) / c.doc.scroll_h : 0; }
      return true;
    case "font_size_rel":
      for (let r = 0; r < n; r++) out[r] = c.medianFont > 0 ? (nodes[rows[r] as number] as SnapNodeLike).style.font_size / c.medianFont : 1;
      return true;
    case "font_weight_rel": for (let r = 0; r < n; r++) out[r] = (nodes[rows[r] as number] as SnapNodeLike).style.font_weight; return true;
    case "pos_fixed_sticky":
      for (let r = 0; r < n; r++) { const p = (nodes[rows[r] as number] as SnapNodeLike).style.position; out[r] = p === "fixed" || p === "sticky" ? 1 : 0; }
      return true;
  }
  const tagMatch = TAG_FEATURES.get(name);
  if (tagMatch) { for (let r = 0; r < n; r++) out[r] = tagMatch((nodes[rows[r] as number] as SnapNodeLike).tag) ? 1 : 0; return true; }
  const lm = LANDMARK_FEATURES.get(name);
  if (lm !== undefined) { for (let r = 0; r < n; r++) out[r] = ((c.landmark[rows[r] as number] as number) & lm) !== 0 ? 1 : 0; return true; }
  const page = PAGE_FEATURES.get(name);
  if (page !== undefined) { const v = (c.pageType & page) !== 0 ? 1 : 0; for (let r = 0; r < n; r++) out[r] = v; return true; }
  if (name.startsWith("hint_")) {
    const h = (HINT_NAMES as readonly string[]).indexOf(name.slice(5));
    if (h < 0) return false;
    for (let r = 0; r < n; r++) out[r] = ((c.hints[rows[r] as number] as number) >> h) & 1;
    return true;
  }
  if (name.startsWith("idclass_hash_")) {
    const b = Number(name.slice(13));
    if (!Number.isInteger(b) || b < 0 || b > 7) return false;
    for (let r = 0; r < n; r++) out[r] = ((c.buckets[rows[r] as number] as number) >> b) & 1;
    return true;
  }
  return false;
}
