import type { NodeLike } from "./types.js";

/**
 * The ONE definition of "rendered" (annotation guide 2.3, protocol 9/10): the rule that decides membership in the
 * labelable universe U, extracted as a pure function so the markdown converter and U cannot drift apart.
 *
 * The Studio's `computeUniverse` (`tools/studio/src/core/universe.ts`) imports `isRenderedNode` / `NON_CONTENT_TAGS`
 * from here, so there is one copy of the rule; the "'rendered' is the rule of U" test of
 * `tools/cli/test/tokens-stage.test.ts` still checks, on every unit of every fixture page, that U === the converter's text.
 */

/** Tags that are never page content: no unit of U, whatever their style. */
export const NON_CONTENT_TAGS: ReadonlySet<string> = new Set(["title", "script", "style", "template", "noscript", "head", "meta", "link", "base"]);

/**
 * An element is rendered when the user sees it after the settle: not `display:none`, not `visibility:hidden|collapse`,
 * not fully transparent (`effectiveOpacity` = the product of `opacity` over the element and its ancestors), laid out
 * (`rect` not null), a real box (not the 1x1 `clip` sr-only pattern, not zero-sized) and not pushed off the left/top.
 */
export function isRenderedNode(n: Pick<NodeLike, "style" | "rect">, effectiveOpacity: number): boolean {
  if (n.style.display === "none") return false;
  if (n.style.visibility === "hidden" || n.style.visibility === "collapse") return false;
  if (effectiveOpacity <= 0) return false;
  const r = n.rect;
  if (r === null) return false; // not laid out: display:none somewhere above, display:contents, or detached
  if (r.w <= 1 && r.h <= 1) return false; // clip(1px,1px) sr-only pattern
  if (r.w <= 0 || r.h <= 0) return false;
  if (r.x + r.w <= 0 || r.y + r.h <= 0) return false; // pushed off-screen to the left or top
  return true;
}

/** Effective opacity per idx: the product of the element's opacity and its ancestors' (pre-order: parent < idx). */
export function effectiveOpacities(nodes: readonly Pick<NodeLike, "parent" | "style">[]): Float64Array {
  const out = new Float64Array(nodes.length);
  nodes.forEach((n, i) => {
    const p = n.parent >= 0 && n.parent < i ? n.parent : -1;
    out[i] = (p >= 0 ? (out[p] as number) : 1) * n.style.opacity;
  });
  return out;
}
