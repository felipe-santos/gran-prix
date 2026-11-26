import { NON_CONTENT_TAGS, effectiveOpacities, isRenderedNode } from "@gran-prix/markdown";
import type { UniverseNode } from "./types.js";

/**
 * The labelable universe U of a page (annotation guide section 2.3), computed from the snapshot's node table:
 *
 *   U = elements with own text (the unit of the label), that are either
 *     - RENDERED: visible to the user after the settle, or
 *     - a content DISCLOSURE: closed <details>, inactive tabpanel, collapsed accordion (`flags.disclosure`).
 *
 * Out of U (automatic noise, never scored): display:none, visibility:hidden/collapse, opacity:0 on the element
 * or on any ancestor, off-screen (left:-9999px, .sr-only clip), zero-size boxes, and everything that is not page
 * content (`<head>`, `<title>`, script, style, template, noscript). Popups, modals and drawers are not disclosures:
 * the collector marks only content exposed by a native control, so a closed modal is simply not rendered.
 *
 * The "rendered" rule and the non-content tags are NOT defined here: they come from `@gran-prix/markdown`
 * (`isRenderedNode`, `NON_CONTENT_TAGS`), the single definition shared with the markdown converter so the two cannot
 * drift apart (the equivalence is tested on every fixture page by `tools/cli/test/tokens-stage.test.ts`, and here in
 * `test/universe.test.ts`). Server-side only: this module is not bundled into the browser UI.
 *
 * Returns, per idx: 0 = not in U, 1 = rendered unit, 2 = disclosure unit.
 */
export function computeUniverse(nodes: readonly UniverseNode[]): Uint8Array {
  const out = new Uint8Array(nodes.length);
  // Pre-order table: a parent always has a smaller idx, so one forward pass sees every ancestor already resolved.
  const inHead = new Uint8Array(nodes.length);
  const opacity = effectiveOpacities(nodes);
  nodes.forEach((n, i) => {
    const p = n.parent >= 0 && n.parent < i ? n.parent : -1;
    inHead[i] = (p >= 0 && inHead[p] === 1) || n.tag === "head" ? 1 : 0;
    if (n.own_text_len <= 0 || inHead[i] === 1 || NON_CONTENT_TAGS.has(n.tag)) return;
    if (n.flags.disclosure === true) {
      out[i] = 2;
      return;
    }
    out[i] = isRenderedNode(n, opacity[i] as number) ? 1 : 0;
  });
  return out;
}

/** Indices of the units of U (rendered or disclosure), in document order. */
export function unitsOf(inU: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < inU.length; i++) if ((inU[i] as number) !== 0) out.push(i);
  return out;
}
