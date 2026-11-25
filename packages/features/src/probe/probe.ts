// probe(): runs in the LIVE page (Playwright evaluate, or later the extension content script) and returns
// the raw material of a PageSnapshot: the pre-order element table, the text units and page signals.
// Everything that needs the live DOM / computed style / layout happens here; `vectorize` only ever sees
// the result.
import { ID_SCHEME, PROBE_VERSION, type ProbeOptions, type RawProbe, type SettleReport, type TextUnit } from "../probe-types.js";
import type { SnapNodeLike } from "../vectorize/types.js";
import { createDisclosureDetector } from "./disclosure.js";
import { jsonLdTypes, ogType, wellFormed } from "./signals.js";
import { settle } from "./settle.js";
import { SKIP_TEXT_TAGS, walkComposed } from "./walk.js";

/** Attributes copied into `attrs`, with a per-attribute character cap. The whitelist is fixed per probe version. */
const ATTR_CAPS: readonly (readonly [string, number])[] = [
  ["id", 128], ["class", 512], ["role", 64], ["href", 512], ["type", 32],
  ["aria-label", 160], ["itemprop", 64], ["alt", 160], ["src", 256], ["name", 64],
];
const FORM_CONTROLS = new Set(["INPUT", "BUTTON", "SELECT", "TEXTAREA"]);

const int = (v: number): number => Math.round(v) + 0; // + 0 turns -0 into +0
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function captureAttrs(el: Element): SnapNodeLike["attrs"] {
  const attrs: SnapNodeLike["attrs"] = {};
  for (const [name, cap] of ATTR_CAPS) {
    let v: string | null;
    // `type` of a form control has an implicit default ("text", "submit", ...): read the property.
    if (name === "type" && FORM_CONTROLS.has(el.tagName)) v = (el as HTMLInputElement).type || null;
    else v = el.getAttribute(name);
    if (v !== null && v !== "") attrs[name] = wellFormed(v.length > cap ? v.slice(0, cap) : v);
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

function captureRect(el: Element, sx: number, sy: number): SnapNodeLike["rect"] {
  if (el.getClientRects().length === 0) return null; // display:none, display:contents, detached
  const r = el.getBoundingClientRect();
  return { x: int(r.left + sx), y: int(r.top + sy), w: int(r.width), h: int(r.height) };
}

function countUnstamped(): number {
  let n = 0;
  walkComposed(document.documentElement, (v) => { if (!v.el.hasAttribute("data-gp-id")) n++; });
  return n;
}

export async function probe(options: ProbeOptions = {}): Promise<RawProbe> {
  const { quietMs = 600, maxMs = 8000, settle: doSettle = true, stamp = true, ownTextCap = 1000, lateCheckMs = 250 } = options;
  const waited = doSettle ? await settle({ quietMs, maxMs }) : null;

  const sx = window.scrollX;
  const sy = window.scrollY;
  const nodes: SnapNodeLike[] = [];
  const texts: TextUnit[] = [];
  const inLink: boolean[] = [];
  const disclosure: boolean[] = [];
  const detector = createDisclosureDetector(document.documentElement);

  walkComposed(
    document.documentElement,
    ({ el, idx, parent, depth, inShadow }) => {
      if (stamp) el.setAttribute("data-gp-id", "n" + idx);
      // Direct (light) text children; <script>/<style>/<noscript>/<template> text is code, not content.
      const own: string[] = [];
      if (!SKIP_TEXT_TAGS.has(el.tagName)) {
        for (const c of el.childNodes) if (c.nodeType === Node.TEXT_NODE && (c.nodeValue ?? "").trim() !== "") own.push(c.nodeValue as string);
      }
      const ownText = wellFormed(own.join("").replace(/\s+/g, " ").trim());
      let childElems = el.children.length;
      if (el.shadowRoot) childElems += el.shadowRoot.children.length;
      const tag = el.tagName.toLowerCase();
      inLink.push(tag === "a" || (parent >= 0 && (inLink[parent] as boolean)));
      const collapsed = detector.test(el, parent >= 0 && (disclosure[parent] as boolean));
      disclosure.push(collapsed);
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
        style: captureStyle(el),
        rect: captureRect(el, sx, sy),
        // `disclosure` is written only when true (absent = false in the contract), so pages without one keep their ids.
        flags: collapsed ? { in_shadow: inShadow, iframe_depth: 0, disclosure: true } : { in_shadow: inShadow, iframe_depth: 0 },
      });
    },
    (t) => {
      const v = t.node.nodeValue ?? "";
      const owner = nodes[t.owner] as SnapNodeLike | undefined;
      if (v.trim() === "" || !owner || SKIP_TEXT_TAGS.has(owner.tag.toUpperCase())) return;
      texts.push({ id: `n${t.owner}#t${t.childIndex}`, owner: t.owner, t: wellFormed(v) });
    },
  );

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

  const de = document.documentElement;
  const og = ogType();
  const types = jsonLdTypes();
  const lang = de.getAttribute("lang");
  const page: RawProbe["page"] = { url: location.href, final_url: location.href };
  if (document.title) page.title = wellFormed(document.title);
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
