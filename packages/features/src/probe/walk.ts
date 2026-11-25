// The composed pre-order: THE id scheme of the pipeline. Every consumer (stamping, snapshot, text
// units, extension content script, collector) must use this order, or ids will not agree.
//
//   visit(element)
//     -> children of its OPEN shadow root (if any), in order
//     -> its light-DOM children, in order
//
//   * element ids are the pre-order index k of the visit: DOM attribute data-gp-id="n<k>", and
//     `nodes[k]` in the snapshot (idx === k);
//   * the parent of a node inside a shadow root is the shadow host (the root itself has no id);
//   * text nodes are not elements and get no attribute; each non-blank LIGHT-DOM text child of an
//     element is a text unit with id "<owner id>#t<child index among the owner's light childNodes>";
//   * NOT entered: <iframe> documents (the iframe element itself is stamped), closed shadow roots,
//     <template> content (a separate fragment), text nodes that sit directly in a shadow root.

import { childNodesOf, nodeTypeOf, shadowRootOf } from "./dom.js";

export const SKIP_TEXT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

export interface Visit {
  el: Element;
  /** Pre-order index (the numeric part of the id). */
  idx: number;
  /** idx of the composed parent, -1 for the root. */
  parent: number;
  depth: number;
  inShadow: boolean;
}

export interface TextVisit {
  owner: number;
  /** Index of the text node among the owner's light childNodes. */
  childIndex: number;
  node: Text;
}

/** Composed-tree children of an element: open-shadow-root children first, then light children. */
export function composedChildNodes(el: Element): Node[] {
  const out: Node[] = [];
  const sr = shadowRootOf(el);
  if (sr) for (const c of childNodesOf(sr)) out.push(c);
  for (const c of childNodesOf(el)) out.push(c);
  return out;
}

/** Walks the composed tree from `root` in pre-order, calling `onEl` per element and `onText` per light text node, interleaved in document order. */
export function walkComposed(root: Element, onEl: (v: Visit) => void, onText?: (t: TextVisit) => void): number {
  type Item = { n: Node; parent: number; depth: number; inShadow: boolean; owner: number; childIndex: number };
  const stack: Item[] = [{ n: root, parent: -1, depth: 0, inShadow: false, owner: -1, childIndex: -1 }];
  let k = 0;
  while (stack.length > 0) {
    const it = stack.pop() as Item;
    if (nodeTypeOf(it.n) === Node.TEXT_NODE) {
      if (onText) onText({ owner: it.owner, childIndex: it.childIndex, node: it.n as Text });
      continue;
    }
    const el = it.n as Element;
    const idx = k++;
    onEl({ el, idx, parent: it.parent, depth: it.depth, inShadow: it.inShadow });
    const sr = shadowRootOf(el);
    const shadowKids = sr ? Array.from(childNodesOf(sr)) : [];
    const lightKids = Array.from(childNodesOf(el));
    // Push in reverse so the stack pops in document order: shadow children first, then light children.
    for (let i = lightKids.length - 1; i >= 0; i--) {
      const c = lightKids[i] as Node;
      const type = nodeTypeOf(c);
      if (type === Node.ELEMENT_NODE) stack.push({ n: c, parent: idx, depth: it.depth + 1, inShadow: it.inShadow, owner: -1, childIndex: -1 });
      else if (type === Node.TEXT_NODE) stack.push({ n: c, parent: idx, depth: it.depth + 1, inShadow: it.inShadow, owner: idx, childIndex: i });
    }
    for (let i = shadowKids.length - 1; i >= 0; i--) {
      const c = shadowKids[i] as Node;
      if (nodeTypeOf(c) === Node.ELEMENT_NODE) stack.push({ n: c, parent: idx, depth: it.depth + 1, inShadow: true, owner: -1, childIndex: -1 });
    }
  }
  return k;
}
