// Per-snapshot derived arrays: everything a feature needs that depends on other nodes (ancestors,
// siblings, subtree, page medians). Pure: reads only the snapshot and the schema's prefilter rules.
import { analyzeText, bucketBits, hintBits, idClassTokens } from "./text.js";
import type { FeatureSchemaLike, SnapNodeLike, SnapshotLike } from "./types.js";

export const LM_MAIN = 1;
export const LM_NAV = 2;
export const LM_HEADER = 4;
export const LM_FOOTER = 8;
export const LM_ASIDE = 16;

export const PAGE_ARTICLE = 1;
export const PAGE_PRODUCT = 2;
export const PAGE_DISCUSSION = 4;

export interface Ctx {
  n: number;
  nodes: SnapNodeLike[];
  doc: SnapshotLike["doc"];
  /** 1 when the node is prefiltered (not a row, excluded from sibling sets and subtree sizes). */
  dropped: Uint8Array;
  /** Index into schema.prefilter.rules of the first rule that dropped the node, or -1. */
  droppedBy: Int16Array;
  /** Non-dropped elements in the composed subtree, self included (0 for dropped nodes). */
  subtree: Int32Array;
  /** Non-dropped siblings (self included) and the 0-based rank of the node among them. */
  sibCount: Int32Array;
  sibRank: Int32Array;
  /** Fraction of the other non-dropped siblings that have the same tag. */
  sibSameTag: Float64Array;
  prev: Int32Array;
  next: Int32Array;
  inLink: Uint8Array;
  /** Landmark bits (LM_*) of the node or any ancestor. */
  landmark: Uint8Array;
  /** Hint bits (see HINT_NAMES) of the node's own id/class or any ancestor's. */
  hints: Uint16Array;
  /** id/class hash bucket bits of the node's own tokens only. */
  buckets: Uint8Array;
  visible: Uint8Array;
  words: Float64Array;
  stopwordRatio: Float64Array;
  punctRatio: Float64Array;
  endsWithPunct: Float64Array;
  medianFont: number;
  rootTextLen: number;
  pageType: number;
}

function roleOf(n: SnapNodeLike): string {
  const r = n.attrs.role;
  if (!r) return "";
  const sp = r.trim().toLowerCase().split(/\s+/);
  return sp[0] ?? "";
}

function landmarkBits(n: SnapNodeLike): number {
  const role = roleOf(n);
  let b = 0;
  if (n.tag === "main" || role === "main") b |= LM_MAIN;
  if (n.tag === "nav" || role === "navigation") b |= LM_NAV;
  if (n.tag === "header" || role === "banner") b |= LM_HEADER;
  if (n.tag === "footer" || role === "contentinfo") b |= LM_FOOTER;
  if (n.tag === "aside" || role === "complementary") b |= LM_ASIDE;
  return b;
}

function stripSchemaOrg(t: string): string {
  const m = /([^/#]+)$/.exec(t);
  return (m?.[1] ?? t).toLowerCase();
}

const ARTICLE_TYPES = new Set(["article", "newsarticle", "blogposting", "techarticle", "scholarlyarticle", "report", "liveblogposting", "socialmediaposting"]);
const PRODUCT_TYPES = new Set(["product", "productgroup", "individualproduct", "offer", "aggregateoffer", "softwareapplication"]);
const DISCUSSION_TYPES = new Set(["discussionforumposting", "qapage", "question", "answer", "comment"]);

export function pageTypeBits(page: SnapshotLike["page"]): number {
  let bits = 0;
  const og = (page.og_type ?? "").trim().toLowerCase();
  if (og === "article" || og.startsWith("article.") || og === "og:article") bits |= PAGE_ARTICLE;
  if (og.startsWith("product") || og.startsWith("og:product")) bits |= PAGE_PRODUCT;
  for (const raw of page.jsonld_types ?? []) {
    const t = stripSchemaOrg(raw);
    if (ARTICLE_TYPES.has(t)) bits |= PAGE_ARTICLE;
    if (PRODUCT_TYPES.has(t)) bits |= PAGE_PRODUCT;
    if (DISCUSSION_TYPES.has(t)) bits |= PAGE_DISCUSSION;
  }
  return bits;
}

/** Median of font sizes of the visible, text-bearing, non-dropped nodes; 16 when there are none. */
function medianFontSize(nodes: SnapNodeLike[], dropped: Uint8Array, visible: Uint8Array): number {
  const sizes: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i] as SnapNodeLike;
    if (dropped[i] === 0 && visible[i] === 1 && nd.own_text_len > 0 && nd.style.font_size > 0) sizes.push(nd.style.font_size);
  }
  if (sizes.length === 0) return 16;
  const a = Float64Array.from(sizes).sort();
  const lo = a[Math.floor((a.length - 1) / 2)] as number;
  const hi = a[Math.floor(a.length / 2)] as number;
  return (lo + hi) / 2;
}

export function derive(snapshot: SnapshotLike, schema: FeatureSchemaLike): Ctx {
  const nodes = snapshot.nodes;
  const n = nodes.length;
  const doc = snapshot.doc;
  const dropped = new Uint8Array(n);
  const droppedBy = new Int16Array(n).fill(-1);
  const hiddenAnc = new Uint8Array(n); // display:none on the node or an ancestor
  const rules = schema.prefilter.rules;

  for (let i = 0; i < n; i++) {
    const nd = nodes[i] as SnapNodeLike;
    const p = nd.parent;
    hiddenAnc[i] = nd.style.display === "none" || (p >= 0 && hiddenAnc[p] === 1) ? 1 : 0;
    for (let r = 0; r < rules.length; r++) {
      const rule = rules[r]!;
      let hit = false;
      if (rule.kind === "tag") hit = rule.tags.includes(nd.tag);
      else if (rule.kind === "style") hit = hiddenAnc[i] === 1; // display:none removes the whole subtree from rendering
      else if (rule.kind === "visibility_hidden") hit = nd.style.visibility === "hidden";
      else if (rule.kind === "zero_rect") hit = nd.rect === null || nd.rect.w <= 0 || nd.rect.h <= 0;
      if (hit) {
        dropped[i] = 1;
        droppedBy[i] = r;
        break;
      }
    }
  }

  // Effective visibility: own box + own style + (opacity:0 hides the subtree) + on the canvas.
  const visible = new Uint8Array(n);
  const opaque = new Uint8Array(n); // no ancestor-or-self has opacity 0
  for (let i = 0; i < n; i++) {
    const nd = nodes[i] as SnapNodeLike;
    const p = nd.parent;
    const parentOpaque = p < 0 ? 1 : (opaque[p] as number);
    opaque[i] = parentOpaque === 1 && nd.style.opacity > 0 ? 1 : 0;
    if (nd.style.display === "contents" && nd.rect === null) {
      visible[i] = p >= 0 && opaque[i] === 1 ? (visible[p] as number) : 0;
      continue;
    }
    const r = nd.rect;
    const onCanvas = r !== null && r.x + r.w > 0 && r.y + r.h > 0 && r.x < doc.scroll_w && r.y < doc.scroll_h;
    visible[i] = r !== null && r.w > 0 && r.h > 0 && onCanvas && nd.style.visibility === "visible" && opaque[i] === 1 ? 1 : 0;
  }

  // Siblings among non-dropped nodes.
  const prev = new Int32Array(n).fill(-1);
  const next = new Int32Array(n).fill(-1);
  const lastChild = new Int32Array(n).fill(-1);
  const childCount = new Int32Array(n + 1); // slot n = virtual parent of the root
  const sibRank = new Int32Array(n);
  const tagCounts = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    if (dropped[i] === 1) continue;
    const nd = nodes[i] as SnapNodeLike;
    const p = nd.parent < 0 ? n : nd.parent;
    if (p < n) {
      const lc = lastChild[p] as number;
      prev[i] = lc;
      if (lc >= 0) next[lc] = i;
      lastChild[p] = i;
    }
    sibRank[i] = childCount[p] as number;
    childCount[p] = (childCount[p] as number) + 1;
    const key = p + "\u0000" + nd.tag;
    tagCounts.set(key, (tagCounts.get(key) ?? 0) + 1);
  }
  const sibCount = new Int32Array(n);
  const sibSameTag = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (dropped[i] === 1) continue;
    const nd = nodes[i] as SnapNodeLike;
    const p = nd.parent < 0 ? n : nd.parent;
    const c = childCount[p] as number;
    sibCount[i] = c;
    sibSameTag[i] = c > 1 ? ((tagCounts.get(p + "\u0000" + nd.tag) ?? 1) - 1) / (c - 1) : 0;
  }

  // Subtree sizes (children come after parents in pre-order, so one reverse pass suffices).
  const subtree = new Int32Array(n);
  for (let i = n - 1; i >= 0; i--) {
    subtree[i] = (subtree[i] as number) + (dropped[i] === 1 ? 0 : 1);
    const p = (nodes[i] as SnapNodeLike).parent;
    if (p >= 0) subtree[p] = (subtree[p] as number) + (subtree[i] as number);
  }

  // Top-down flags.
  const inLink = new Uint8Array(n);
  const landmark = new Uint8Array(n);
  const hints = new Uint16Array(n);
  const buckets = new Uint8Array(n);
  const words = new Float64Array(n);
  const stopwordRatio = new Float64Array(n);
  const punctRatio = new Float64Array(n);
  const endsWithPunct = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const nd = nodes[i] as SnapNodeLike;
    const p = nd.parent;
    inLink[i] = nd.tag === "a" || (p >= 0 && inLink[p] === 1) ? 1 : 0;
    landmark[i] = landmarkBits(nd) | (p >= 0 ? (landmark[p] as number) : 0);
    if (dropped[i] === 1) {
      // A dropped node's own tokens are ignored, but its descendants still inherit the ancestors' bits.
      hints[i] = p >= 0 ? (hints[p] as number) : 0;
      continue;
    }
    const tokens = idClassTokens(nd.attrs.id, nd.attrs.class);
    hints[i] = hintBits(tokens) | (p >= 0 ? (hints[p] as number) : 0);
    buckets[i] = bucketBits(tokens);
    if (nd.own_text_len > 0) {
      const s = analyzeText(nd.own_text, nd.own_text_len);
      // Words of the full text, extrapolated from the sample when the probe truncated it.
      const frac = nd.own_text.length > 0 ? nd.own_text_len / nd.own_text.length : 1;
      words[i] = s.words * frac;
      stopwordRatio[i] = s.stopwordRatio;
      punctRatio[i] = s.punctRatio;
      endsWithPunct[i] = s.endsWithPunct;
    }
  }
  return {
    n,
    nodes,
    doc,
    dropped,
    droppedBy,
    subtree,
    sibCount,
    sibRank,
    sibSameTag,
    prev,
    next,
    inLink,
    landmark,
    hints,
    buckets,
    visible,
    words,
    stopwordRatio,
    punctRatio,
    endsWithPunct,
    medianFont: medianFontSize(nodes, dropped, visible),
    rootTextLen: n > 0 ? (nodes[0] as SnapNodeLike).text_len : 0,
    pageType: pageTypeBits(snapshot.page),
  };
}
