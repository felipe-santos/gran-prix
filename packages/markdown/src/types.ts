/**
 * The slice of a `PageSnapshot` node that this package reads. Structural on purpose: a `SnapNode` of the contract
 * (and the Studio's `UniverseNode`) satisfies it, and the package needs no dependency on `@gran-prix/contracts`.
 */
export interface NodeLike {
  idx: number;
  /** Parent idx, -1 for the root; always < idx (composed-tree pre-order). */
  parent: number;
  /** Lowercase tag name. */
  tag: string;
  /** Characters of the element's own (direct) text: > 0 makes the element a unit of the labelable universe U. */
  own_text_len: number;
  style: { display: string; visibility: string; opacity: number };
  rect: { x: number; y: number; w: number; h: number } | null;
  flags: { disclosure?: boolean };
}

/**
 * What to do with the content of a COLLAPSED DISCLOSURE (closed `<details>`, inactive tabpanel, accordion panel;
 * `flags.disclosure`). It is part of the labelable universe U, but it is not rendered.
 *  - "exclude": it is not rendered, so it is removed like any other unrendered element (the literal reading of
 *    protocol section 10, and the smallest D2).
 *  - "include": it is page content exposed by a native control, so it stays.
 */
export type CollapsedPolicy = "exclude" | "include";
