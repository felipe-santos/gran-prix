import type { LightNode } from "./types.js";

/**
 * Static structure of one page: the composed tree in pre-order (`parent < idx`, so the subtree of `i` is the
 * contiguous range `[i, i + size[i])`), and the universe U. Built once per page, never mutated.
 */
export interface PageModel {
  n: number;
  parent: Int32Array;
  /** Number of nodes in the subtree of i, i included. */
  size: Int32Array;
  /** 0 = not in U, 1 = rendered unit, 2 = disclosure unit. */
  inU: Uint8Array;
  /** Units of U in document order. */
  units: number[];
  /** Position of an idx in `units` (-1 when not a unit). */
  unitPos: Int32Array;
  /** Number of units in the subtree of i (i included). */
  unitsBelow: Int32Array;
}

export function buildModel(nodes: readonly Pick<LightNode, "p" | "u">[]): PageModel {
  const n = nodes.length;
  const parent = new Int32Array(n);
  const size = new Int32Array(n).fill(1);
  const inU = new Uint8Array(n);
  const unitsBelow = new Int32Array(n);
  const unitPos = new Int32Array(n).fill(-1);
  const units: number[] = [];
  nodes.forEach((nd, i) => {
    if (nd.p >= i || nd.p < -1) throw new RangeError(`node ${i}: parent ${nd.p} breaks the pre-order invariant (parent < idx)`);
    parent[i] = nd.p;
    inU[i] = nd.u;
    if (nd.u !== 0) {
      unitPos[i] = units.length;
      units.push(i);
      unitsBelow[i] = 1;
    }
  });
  for (let i = n - 1; i > 0; i--) {
    const p = parent[i] as number;
    if (p >= 0) {
      size[p] = (size[p] as number) + (size[i] as number);
      unitsBelow[p] = (unitsBelow[p] as number) + (unitsBelow[i] as number);
    }
  }
  return { n, parent, size, inU, units, unitPos, unitsBelow };
}

/** True when `a` is `b` or an ancestor of `b`. */
export const containsNode = (m: PageModel, a: number, b: number): boolean => b >= a && b < a + (m.size[a] as number);

/** Direct children of i, in document order. */
export function childrenOf(m: PageModel, i: number): number[] {
  const out: number[] = [];
  const end = i + (m.size[i] as number);
  for (let c = i + 1; c < end; c += m.size[c] as number) out.push(c);
  return out;
}
