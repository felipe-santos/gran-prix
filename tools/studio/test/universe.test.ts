import { describe, expect, it } from "vitest";
import { buildModel } from "../src/core/model.js";
import { computeUniverse, unitsOf } from "../src/core/universe.js";
import type { UniverseNode } from "../src/core/types.js";

const node = (idx: number, parent: number, over: Partial<UniverseNode> & { rect?: UniverseNode["rect"] } = {}): UniverseNode => ({
  idx,
  parent,
  tag: "div",
  own_text_len: 5,
  style: { display: "block", visibility: "visible", opacity: 1 },
  rect: { x: 10, y: 10, w: 200, h: 20 },
  flags: {},
  ...over,
});

describe("universe U (guide 2.3)", () => {
  it("keeps rendered elements with own text and drops the rest", () => {
    const nodes: UniverseNode[] = [
      node(0, -1, { tag: "html", own_text_len: 0 }),
      node(1, 0, { tag: "head", own_text_len: 0, rect: null, style: { display: "none", visibility: "visible", opacity: 1 } }),
      node(2, 1, { tag: "title", rect: null }),
      node(3, 0, { tag: "body", own_text_len: 0 }),
      node(4, 3, { tag: "p" }), // rendered unit
      node(5, 3, { tag: "div", own_text_len: 0 }), // container without own text: never a unit
      node(6, 3, { tag: "p", style: { display: "none", visibility: "visible", opacity: 1 }, rect: null }), // display:none
      node(7, 3, { tag: "p", style: { display: "block", visibility: "hidden", opacity: 1 } }), // .stealth
      node(8, 3, { tag: "a", rect: { x: -9999, y: 0, w: 1, h: 1 } }), // .sr-only
      node(9, 3, { tag: "p", style: { display: "block", visibility: "visible", opacity: 0 } }), // opacity:0
      node(10, 9, { tag: "span" }), // child of an opacity:0 element: invisible although its own opacity is 1
      node(11, 3, { tag: "script", rect: null }),
      node(12, 3, { tag: "p", rect: { x: -500, y: 0, w: 100, h: 20 } }), // off-screen left, bigger than 1px
      node(13, 3, { tag: "p", rect: { x: 0, y: 0, w: 0, h: 0 } }), // zero-size
    ];
    const u = computeUniverse(nodes);
    expect(unitsOf(u)).toEqual([4]);
    expect(u[4]).toBe(1);
  });

  it("includes collapsed disclosure content (flag) even though it is not rendered, but not head or script text", () => {
    const hidden = { style: { display: "none", visibility: "visible", opacity: 1 }, rect: null };
    const nodes: UniverseNode[] = [
      node(0, -1, { tag: "html", own_text_len: 0 }),
      node(1, 0, { tag: "details", own_text_len: 0 }),
      node(2, 1, { tag: "p", ...hidden, flags: { disclosure: true } }),
      node(3, 1, { tag: "p", ...hidden }), // a plain hidden element next to it: out
      node(4, 0, { tag: "script", ...hidden, flags: { disclosure: true } }), // never page text
    ];
    const u = computeUniverse(nodes);
    expect(Array.from(u)).toEqual([0, 0, 2, 0, 0]);
  });

  it("buildModel exposes units, subtree sizes and unit counts, and rejects a broken pre-order", () => {
    const m = buildModel([
      { p: -1, u: 0 },
      { p: 0, u: 1 },
      { p: 1, u: 2 },
      { p: 0, u: 0 },
      { p: 3, u: 1 },
    ]);
    expect(m.units).toEqual([1, 2, 4]);
    expect(Array.from(m.size)).toEqual([5, 2, 1, 2, 1]);
    expect(Array.from(m.unitsBelow)).toEqual([3, 2, 1, 1, 1]);
    expect(() => buildModel([{ p: 1, u: 0 }, { p: -1, u: 0 }])).toThrow(/pre-order/);
  });
});
