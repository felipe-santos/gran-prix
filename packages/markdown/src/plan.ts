import { NON_CONTENT_TAGS, effectiveOpacities, isRenderedNode } from "./rendered.js";
import type { CollapsedPolicy, NodeLike } from "./types.js";

/**
 * What the converter does with each element, decided from the snapshot's node table alone (no DOM): pure, so it is
 * tested without a browser and shared by D2 and the pruned output.
 *
 *   ACT_DROP       the element and its whole subtree are removed
 *   ACT_CONTAINER  the element stays as structure; its OWN text (direct text nodes) is removed, children decide for themselves
 *   ACT_FULL       the element stays, with its own text
 */
export const ACT_DROP = 0;
export const ACT_CONTAINER = 1;
export const ACT_FULL = 2;
export type Act = typeof ACT_DROP | typeof ACT_CONTAINER | typeof ACT_FULL;

/** D2 removes these (protocol 10) wherever they are; `NON_CONTENT_TAGS` (head, title, meta, ...) go with them. */
export const D2_REMOVED_TAGS: ReadonlySet<string> = new Set(["script", "style", "noscript", "template", "svg"]);

export interface PlanOptions {
  /** Collapsed disclosures; see `CollapsedPolicy`. */
  collapsed: CollapsedPolicy;
  /**
   * Units (element idx) to keep. Absent or null: the whole page (D2). Present: the pruned output (a `Set`, possibly empty).
   */
  keep?: ReadonlySet<number> | null;
}

export interface Plan {
  /** `Act` per idx. */
  act: Uint8Array;
  /** 1 when the element's own text is part of the rendered page (units of U that are rendered, or kept disclosures). */
  text: Uint8Array;
}

/**
 * Rendered state (one pass, parents first):
 *  - An element is GONE (subtree dropped) when it is not content (`D2_REMOVED_TAGS`, `NON_CONTENT_TAGS`), is
 *    `display:none`, is fully transparent (own x ancestors' opacity) or sits inside a gone element. An `<img>` that is
 *    not rendered by `isRenderedNode` (hidden, 1x1 pixel, off-screen) is gone too. These are the rules of U that
 *    propagate to descendants. `rect === null` alone does NOT drop a subtree: `display:contents` has no rect and its
 *    children are on screen.
 *  - The own text of an element survives iff it is a unit of U in the sense of `isRenderedNode` (the full rule, which
 *    also catches visibility, the 1x1 clip and the off-screen patterns, per element: a descendant decides for itself).
 *  - A collapsed disclosure (`flags.disclosure`) is not rendered: `exclude` drops it, `include` keeps it and skips the
 *    rendered test, exactly as U does (U marks disclosure units without testing display or rect).
 */
function renderState(nodes: readonly NodeLike[], collapsed: CollapsedPolicy): { gone: Uint8Array; text: Uint8Array } {
  const n = nodes.length;
  const gone = new Uint8Array(n);
  const text = new Uint8Array(n);
  const opacity = effectiveOpacities(nodes);
  nodes.forEach((node, i) => {
    const p = node.parent >= 0 && node.parent < i ? node.parent : -1;
    const flagged = node.flags.disclosure === true;
    let g = p >= 0 && gone[p] === 1;
    if (D2_REMOVED_TAGS.has(node.tag) || NON_CONTENT_TAGS.has(node.tag)) g = true;
    if (flagged) {
      if (collapsed === "exclude") g = true;
    } else if (node.style.display === "none" || (opacity[i] as number) <= 0) {
      g = true;
    }
    if (!g && node.tag === "img" && !flagged && !isRenderedNode(node, opacity[i] as number)) g = true;
    gone[i] = g ? 1 : 0;
    text[i] = !g && node.own_text_len > 0 && (flagged || isRenderedNode(node, opacity[i] as number)) ? 1 : 0;
  });
  return { gone, text };
}

/**
 * The plan of a page.
 *
 * Whole page (`keep` absent): GONE elements are dropped; an element whose own text is not rendered loses that text and
 * stays as structure (ACT_CONTAINER) only if something rendered lives below it, else it is dropped too (a hidden
 * "skip to content" link must not leave an empty `[](#x)` behind); everything else is ACT_FULL.
 *
 * Pruned output (`keep` given). K = the kept units that are themselves rendered text. An element survives when it is
 *  1. in K: ACT_FULL, with its own text;
 *  2. an ancestor of an element of K: ACT_CONTAINER, structure only, its own text removed;
 *  3. DECORATION of a kept element: a descendant, under a chain of kept or decoration elements, whose whole subtree
 *     holds no unit (no own text anywhere): `<br>`, `<hr>`, `<img>`, empty wrappers. ACT_FULL (it has no text to lose;
 *     an image keeps its `![alt]()`).
 *  Everything else is dropped: a non-kept unit with its subtree (a kept descendant of a non-kept unit survives as in
 *  case 2, because the ancestor rule wins over the drop), siblings without a kept descendant, hidden elements.
 */
export function planPage(nodes: readonly NodeLike[], opts: PlanOptions): Plan {
  const n = nodes.length;
  const { gone, text } = renderState(nodes, opts.collapsed);
  const act = new Uint8Array(n);
  const keep = opts.keep ?? null;
  if (keep === null) {
    // live[i]: rendered text or a rendered image at i or below it.
    const live = new Uint8Array(n);
    for (let i = n - 1; i >= 0; i--) {
      const node = nodes[i] as NodeLike;
      if (text[i] === 1 || (gone[i] === 0 && node.tag === "img")) live[i] = 1;
      const p = node.parent >= 0 && node.parent < i ? node.parent : -1;
      if (p >= 0 && live[i] === 1) live[p] = 1;
    }
    for (let i = 0; i < n; i++) {
      if (gone[i] === 1) continue; // ACT_DROP
      // An element whose own text is not rendered (visibility, the sr-only clip, off-screen) keeps its structure only
      // when something rendered lives below it; otherwise it is gone, not left behind as an empty `[](#link)`.
      act[i] = (nodes[i] as NodeLike).own_text_len > 0 && text[i] === 0 ? (live[i] === 1 ? ACT_CONTAINER : ACT_DROP) : ACT_FULL;
    }
    return { act, text };
  }

  const kept = new Uint8Array(n);
  for (let i = 0; i < n; i++) kept[i] = keep.has(i) && text[i] === 1 ? 1 : 0;
  // anc[i]: some element of K lies strictly below i. hasUnit[i]: i or something below it owns rendered text.
  const anc = new Uint8Array(n);
  const hasUnit = new Uint8Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const node = nodes[i] as NodeLike;
    if (gone[i] === 0 && node.own_text_len > 0) hasUnit[i] = 1;
    const p = node.parent >= 0 && node.parent < i ? node.parent : -1;
    if (p >= 0) {
      if (kept[i] === 1 || anc[i] === 1) anc[p] = 1;
      if (hasUnit[i] === 1) hasUnit[p] = 1;
    }
  }
  const decor = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const node = nodes[i] as NodeLike;
    const p = node.parent >= 0 && node.parent < i ? node.parent : -1;
    if (gone[i] === 1) continue; // act stays ACT_DROP
    decor[i] = hasUnit[i] === 0 && p >= 0 && (kept[p] === 1 || decor[p] === 1) ? 1 : 0;
    act[i] = kept[i] === 1 ? ACT_FULL : anc[i] === 1 ? ACT_CONTAINER : decor[i] === 1 ? ACT_FULL : ACT_DROP;
  }
  return { act, text };
}
