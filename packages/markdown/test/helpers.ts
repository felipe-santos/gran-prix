import { JSDOM } from "jsdom";
import type { NodeLike } from "../src/index.js";

/**
 * A synthetic "snapshot" of a hand-written body: every element is numbered in pre-order (html, head, body, ...),
 * stamped with `data-gp-id`, and gets a node of the table. Styles are the browser defaults (a visible block with a
 * 100x20 box) unless the markup says otherwise with `data-t-*` attributes:
 *   data-t-display="none"  data-t-visibility="hidden"  data-t-opacity="0"  data-t-rect="x,y,w,h" | "null"  data-t-disclosure
 */
export interface Fixture {
  /** The html as the collector stores it (serialized after stamping). */
  stored: string;
  nodes: NodeLike[];
  /** Idx of the elements matching a selector, in document order. */
  idx(selector: string): number[];
  /** First idx of a selector (throws when absent). */
  one(selector: string): number;
}

const ownTextLen = (el: Element): number =>
  Array.from(el.childNodes)
    .filter((c) => c.nodeType === 3)
    .map((c) => c.nodeValue ?? "")
    .join("")
    .replace(/\s+/g, " ")
    .trim().length;

export function fixture(bodyHtml: string, head = ""): Fixture {
  const dom = new JSDOM(`<!DOCTYPE html><html><head>${head}</head><body>${bodyHtml}</body></html>`);
  const doc = dom.window.document;
  const all: Element[] = [];
  const walk = (el: Element): void => {
    all.push(el);
    for (const c of Array.from(el.children)) walk(c);
  };
  walk(doc.documentElement);
  const nodes: NodeLike[] = all.map((el, idx) => {
    el.setAttribute("data-gp-id", `n${idx}`);
    const parent = el.parentElement ? all.indexOf(el.parentElement) : -1;
    const rectAttr = el.getAttribute("data-t-rect");
    const rect = rectAttr === "null" ? null : rectAttr ? ((([x, y, w, h]) => ({ x: x as number, y: y as number, w: w as number, h: h as number }))(rectAttr.split(",").map(Number))) : { x: 0, y: 0, w: 100, h: 20 };
    return {
      idx,
      parent,
      tag: el.localName,
      own_text_len: ownTextLen(el),
      style: {
        display: el.getAttribute("data-t-display") ?? "block",
        visibility: el.getAttribute("data-t-visibility") ?? "visible",
        opacity: Number(el.getAttribute("data-t-opacity") ?? "1"),
      },
      rect,
      flags: el.hasAttribute("data-t-disclosure") ? { disclosure: true } : {},
    };
  });
  const idx = (selector: string): number[] => Array.from(doc.querySelectorAll(selector)).map((e) => all.indexOf(e));
  const one = (selector: string): number => {
    const r = idx(selector)[0];
    if (r === undefined) throw new Error(`no element matches ${selector}`);
    return r;
  };
  return { stored: doc.documentElement.outerHTML, nodes, idx, one };
}
