// probe(): runs in the LIVE page (Playwright evaluate, or later the extension content script) and returns
// the raw material of a PageSnapshot: the pre-order element table, the text units and page signals.
// Everything that needs the live DOM / computed style / layout happens here; `vectorize` only ever sees
// the result.
//
// Performance (G5, probe 0.2.0 output unchanged byte for byte): one fused traversal in the composed pre-order of
// ./walk.ts (the id scheme; test/fixtures.e2e.test.ts keeps them together) that reads each node's children once and
// keeps its stack in parallel arrays; the disclosure detector runs afterwards over the collected elements and touches
// the computed style only of the few elements that can be disclosure roots; `data-gp-id` is written after all the reads.
import { ID_SCHEME, PROBE_VERSION, type ProbeOptions, type RawProbe, type SettleReport, type TextUnit } from "../probe-types.js";
import type { SnapNodeLike } from "../vectorize/types.js";
import { createDisclosureDetector } from "./disclosure.js";
import { childNodesOf, childrenOf, rootChildrenOf, clientRectCount, clientRectOf, controlTypeOf, docTitle, getAttr, hasAttr, nodeTypeOf, nodeValueOf, rootElement, setAttr, shadowRootOf, tagNameOf } from "./dom.js";
import { jsonLdTypes, ogType, wellFormed } from "./signals.js";
import { settle } from "./settle.js";
import { SKIP_TEXT_TAGS } from "./walk.js";

/** Attributes copied into `attrs`, with a per-attribute character cap. The whitelist is fixed per probe version. */
const ATTR_NAMES: readonly string[] = ["id", "class", "role", "href", "type", "aria-label", "itemprop", "alt", "src", "name"];
const ATTR_LIMITS: readonly number[] = [128, 512, 64, 512, 32, 160, 64, 160, 256, 64];
const TYPE_ATTR = 4; // index of "type" in the lists above

const int = (v: number): number => Math.round(v) + 0; // + 0 turns -0 into +0
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function captureAttrs(el: Element): SnapNodeLike["attrs"] {
  const attrs: SnapNodeLike["attrs"] = {};
  for (let i = 0; i < ATTR_NAMES.length; i++) {
    let v: string | null;
    // `type` of a form control has an implicit default ("text", "submit", ...): read the property.
    const ct = i === TYPE_ATTR ? controlTypeOf(el) : null;
    if (ct !== null) v = ct || null;
    else v = getAttr(el, ATTR_NAMES[i] as string);
    if (v !== null && v !== "") {
      const cap = ATTR_LIMITS[i] as number;
      attrs[ATTR_NAMES[i] as string] = wellFormed(v.length > cap ? v.slice(0, cap) : v);
    }
  }
  return attrs;
}

/** Truncates at `cap` UTF-16 units without cutting a surrogate pair in half. */
function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const code = s.charCodeAt(cap - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? cap - 1 : cap);
}

function captureStyle(el: Element): SnapNodeLike["style"] {
  const cs = getComputedStyle(el);
  const opacity = parseFloat(cs.opacity);
  const fs = parseFloat(cs.fontSize);
  const fw = parseFloat(cs.fontWeight);
  const style: SnapNodeLike["style"] = {
    display: cs.display,
    visibility: cs.visibility,
    opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1,
    position: cs.position,
    font_size: Number.isFinite(fs) ? fs : 0,
    font_weight: Number.isFinite(fw) ? fw : 400,
  };
  if (cs.cssFloat && cs.cssFloat !== "none") style.float = cs.cssFloat;
  const z = parseInt(cs.zIndex, 10);
  if (Number.isFinite(z)) style.z_index = z;
  return style;
}

/**
 * Null when the element has no box (display:none, display:contents, detached): `getClientRects()` is empty. An element
 * without a layout object has an all-zero bounding rect, so a rect with any non-zero side already proves there is a box
 * and the second call is only made for the all-zero rects (empty inline elements at the origin, and the boxless ones).
 */
function captureRect(el: Element, sx: number, sy: number): SnapNodeLike["rect"] {
  const r = clientRectOf(el);
  const left = r.left;
  const top = r.top;
  const width = r.width;
  const height = r.height;
  if (width === 0 && height === 0 && left === 0 && top === 0 && clientRectCount(el) === 0) return null;
  return { x: int(left + sx), y: int(top + sy), w: int(width), h: int(height) };
}

/** Elements of the composed tree without `data-gp-id` (an order-free count, so no ids and no text nodes are needed). */
function countUnstamped(): number {
  let n = 0;
  const stack: Element[] = [rootElement() as Element];
  while (stack.length > 0) {
    const el = stack.pop() as Element;
    if (!hasAttr(el, "data-gp-id")) n++;
    const sr = shadowRootOf(el);
    if (sr) for (const c of rootChildrenOf(sr)) stack.push(c);
    for (const c of childrenOf(el)) stack.push(c);
  }
  return n;
}

export async function probe(options: ProbeOptions = {}): Promise<RawProbe> {
  const { quietMs = 600, maxMs = 8000, settle: doSettle = true, stamp = true, ownTextCap = 1000, lateCheckMs = 250 } = options;
  const waited = doSettle ? await settle({ quietMs, maxMs }) : null;

  const sx = window.scrollX;
  const sy = window.scrollY;
  const nodes: SnapNodeLike[] = [];
  const texts: TextUnit[] = [];
  const els: Element[] = [];
  const inLink: boolean[] = [];
  const hasHidden: boolean[] = [];
  const noBox: boolean[] = []; // display:none on the element or an ancestor: no layout box in the whole subtree
  const controls: Element[] = [];

  // The traversal stack, in parallel arrays. An item is an element to visit (txt === null) or a non-blank text node of an
  // element's light children, already read (txt = its value); `a` = composed parent idx for an element, owner idx for a text.
  const stNode: (Node | null)[] = [rootElement()];
  const stA: number[] = [-1];
  const stDepth: number[] = [0];
  const stShadow: boolean[] = [false];
  const stIndex: number[] = [-1]; // child index among the owner's light childNodes, for a text
  const stTxt: (string | null)[] = [null];
  let k = 0;
  while (stNode.length > 0) {
    const n = stNode.pop() as Node;
    const parent = stA.pop() as number;
    const depth = stDepth.pop() as number;
    const inShadow = stShadow.pop() as boolean;
    const childIndex = stIndex.pop() as number;
    const txt = stTxt.pop() as string | null;
    if (txt !== null) {
      texts.push({ id: `n${parent}#t${childIndex}`, owner: parent, t: wellFormed(txt) });
      continue;
    }
    const el = n as Element;
    const idx = k++;
    els.push(el);

    const tagUpper = tagNameOf(el);
    const tag = tagUpper.toLowerCase();
    const skipOwn = SKIP_TEXT_TAGS.has(tagUpper);
    const skipUnits = SKIP_TEXT_TAGS.has(tag.toUpperCase());
    // One pass over the light children: element children are counted and queued, non-blank text is read once.
    const light = childNodesOf(el);
    const nLight = light.length;
    let childElems = 0;
    let own: string[] | null = null;
    const base = stNode.length;
    for (let i = 0; i < nLight; i++) {
      const c = light[i] as Node;
      const type = nodeTypeOf(c);
      if (type === ELEMENT_NODE) {
        childElems++;
        stNode.push(c); stA.push(idx); stDepth.push(depth + 1); stShadow.push(inShadow); stIndex.push(-1); stTxt.push(null);
      } else if (type === TEXT_NODE) {
        const nv = nodeValueOf(c) ?? "";
        if (nv.trim() === "") continue;
        if (!skipOwn) (own ??= []).push(nv);
        if (!skipUnits) { stNode.push(c); stA.push(idx); stDepth.push(0); stShadow.push(false); stIndex.push(i); stTxt.push(nv); }
      }
    }
    reverseTail(base, stNode, stA, stDepth, stShadow, stIndex, stTxt); // the stack pops in document order
    const sr = shadowRootOf(el);
    if (sr) {
      const kids = childNodesOf(sr);
      const nKids = kids.length;
      const sBase = stNode.length;
      for (let i = 0; i < nKids; i++) {
        const c = kids[i] as Node;
        if (nodeTypeOf(c) !== ELEMENT_NODE) continue;
        childElems++;
        stNode.push(c); stA.push(idx); stDepth.push(depth + 1); stShadow.push(true); stIndex.push(-1); stTxt.push(null);
      }
      reverseTail(sBase, stNode, stA, stDepth, stShadow, stIndex, stTxt); // shadow children come before the light ones
    }

    const ownText = own === null ? "" : wellFormed((own.length === 1 ? (own[0] as string) : own.join("")).replace(/\s+/g, " ").trim());
    inLink.push(tag === "a" || (parent >= 0 && (inLink[parent] as boolean)));
    hasHidden.push(hasAttr(el, "hidden"));
    if (hasAttr(el, "aria-controls")) controls.push(el);
    const style = captureStyle(el);
    const boxless = style.display === "none" || (parent >= 0 && (noBox[parent] as boolean));
    noBox.push(boxless);
    nodes.push({
      idx,
      parent,
      depth,
      tag,
      attrs: captureAttrs(el),
      own_text: truncate(ownText, ownTextCap),
      own_text_len: ownText.length,
      text_len: 0, // subtree totals are filled below
      link_text_len: 0,
      child_elems: childElems,
      style,
      rect: boxless || style.display === "contents" ? null : captureRect(el, sx, sy), // what getClientRects() answers (an empty list), without asking
      flags: { in_shadow: inShadow, iframe_depth: 0 }, // `disclosure` is added below, only when true
    });
  }

  // Collapsed disclosures (`flags.disclosure`), decided in pre-order from the already captured style, attributes and parent flag.
  const detector = createDisclosureDetector(controls);
  const disclosure: boolean[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i] as SnapNodeLike;
    const parentFlag = nd.parent >= 0 && (disclosure[nd.parent] as boolean);
    const collapsed = detector.test(els[i] as Element, parentFlag, nd.style.display, nd.parent >= 0 ? (nodes[nd.parent] as SnapNodeLike).tag : "", hasHidden[i] as boolean, nd.attrs.role);
    disclosure.push(collapsed);
    // `disclosure` is written only when true (absent = false in the contract), so pages without one keep their ids.
    if (collapsed) nd.flags = { in_shadow: nd.flags.in_shadow, iframe_depth: 0, disclosure: true };
  }

  // Ids last: every read above saw the page as it was.
  if (stamp) for (let i = 0; i < els.length; i++) setAttr(els[i] as Element, "data-gp-id", "n" + i);

  // Subtree totals: parents precede children in pre-order, so a reverse pass accumulates upward.
  const own = nodes.map((n) => n.own_text_len);
  const linkOwn = nodes.map((n, i) => (inLink[i] ? n.own_text_len : 0));
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i] as SnapNodeLike;
    n.text_len += own[i] as number;
    n.link_text_len += linkOwn[i] as number;
    if (n.parent >= 0) {
      const p = nodes[n.parent] as SnapNodeLike;
      p.text_len += n.text_len;
      p.link_text_len += n.link_text_len;
    }
  }

  const de = rootElement() as Element;
  const og = ogType();
  const types = jsonLdTypes();
  const lang = getAttr(de, "lang");
  const page: RawProbe["page"] = { url: location.href, final_url: location.href };
  const title = docTitle();
  if (title) page.title = wellFormed(title);
  if (lang) page.lang = wellFormed(lang.slice(0, 35));
  if (og) page.og_type = og;
  if (types.length > 0) page.jsonld_types = types;

  // Evidence for the settle rule: elements that appeared after stamping have no id.
  let late = 0;
  if (stamp) {
    await sleep(lateCheckMs);
    late = countUnstamped();
  }
  const report: SettleReport = waited
    ? { ...waited, late_unstamped: late }
    : { reason: "skipped", waited_ms: 0, mutations: 0, shadow_roots: 0, tracked_from_start: false, late_unstamped: late };

  return {
    page,
    doc: { viewport_w: window.innerWidth, viewport_h: window.innerHeight, scroll_w: de.scrollWidth, scroll_h: de.scrollHeight },
    nodes,
    text_units: texts,
    probe: { id_scheme: ID_SCHEME, version: PROBE_VERSION, own_text_cap: ownTextCap },
    settle: report,
  };
}

/** Reverses the items pushed since `from` in every parallel stack array. */
function reverseTail(from: number, ...arrays: unknown[][]): void {
  for (const a of arrays) {
    for (let i = from, j = a.length - 1; i < j; i++, j--) {
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
  }
}
