import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NON_CONTENT_TAGS, planPage } from "@gran-prix/markdown";
import { describe, expect, inject, it } from "vitest";
import { listPages } from "../src/server/snapshot-set.js";
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

describe("the rule of U comes from @gran-prix/markdown (debt a)", () => {
  it("universe.ts keeps no copy of the rule: it imports isRenderedNode and NON_CONTENT_TAGS", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/core/universe.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/from "@gran-prix\/markdown"/);
    expect(src).not.toMatch(/new Set\(\[\s*"title"/);
    expect(src).not.toMatch(/function isRendered/);
    expect(NON_CONTENT_TAGS.has("script") && NON_CONTENT_TAGS.has("head") && !NON_CONTENT_TAGS.has("p")).toBe(true);
  });

  it("parity: on every unit of the 10 fixture pages, U agrees with the text the markdown converter keeps", () => {
    const refs = listPages(inject("calibrationDataDir"));
    expect(refs).toHaveLength(10);
    let units = 0;
    for (const ref of refs) {
      const nodes = ref.reader.snapshot(ref.entry).nodes;
      const u = computeUniverse(nodes);
      const inclusive = planPage(nodes, { collapsed: "include" }).text;
      const exclusive = planPage(nodes, { collapsed: "exclude" }).text;
      const inSvg = new Uint8Array(nodes.length);
      nodes.forEach((n, i) => (inSvg[i] = n.tag === "svg" || (n.parent >= 0 && inSvg[n.parent] === 1) ? 1 : 0)); // D2 drops svg wholesale; U does not look at it
      nodes.forEach((n, i) => {
        if (n.own_text_len === 0 || inSvg[i] === 1) return;
        units++;
        expect(inclusive[i] === 1, `${ref.entry.url} n${i} <${n.tag}>`).toBe(u[i] !== 0);
        expect(exclusive[i] === 1, `${ref.entry.url} n${i} <${n.tag}>`).toBe(u[i] === 1);
      });
    }
    expect(units).toBeGreaterThan(300);
  });
});
