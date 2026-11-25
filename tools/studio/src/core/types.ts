/**
 * Shared, dependency-free types of the Studio (used by the server and by the browser UI, so nothing in
 * `src/core` may import Node APIs or runtime code of the contracts).
 */

/** ADR-006 label space, in class-index order (main = 0, support = 1, noise = 2). */
export const LABEL_CLASSES = ["main", "support", "noise"] as const;
export type LabelClass = (typeof LABEL_CLASSES)[number];

export const FLAGS = ["doubt", "mixed"] as const;
export type Flag = (typeof FLAGS)[number];

export const isLabelClass = (v: unknown): v is LabelClass => typeof v === "string" && (LABEL_CLASSES as readonly string[]).includes(v);
export const isFlag = (v: unknown): v is Flag => typeof v === "string" && (FLAGS as readonly string[]).includes(v);

export const classIndex = (c: LabelClass): number => LABEL_CLASSES.indexOf(c);

export const MODES = ["blind", "review"] as const;
export type Mode = (typeof MODES)[number];
export const isMode = (v: unknown): v is Mode => v === "blind" || v === "review";

/** Version of the annotation guide the labels are made under (the guide is frozen as v1.0 after calibration). */
export const GUIDE_VERSION = "1.0-draft";

/** The slice of a `PageSnapshot` node that decides membership in the universe U. */
export interface UniverseNode {
  idx: number;
  parent: number;
  tag: string;
  own_text_len: number;
  style: { display: string; visibility: string; opacity: number };
  rect: { x: number; y: number; w: number; h: number } | null;
  flags: { disclosure?: boolean };
}

/** Per-page labeling state: explicit labels by node idx (nearest-ancestor inheritance) plus per-element flags. */
export interface LabelState {
  explicit: Record<string, LabelClass>;
  flags: Record<string, Flag[]>;
}

export const emptyLabelState = (): LabelState => ({ explicit: {}, flags: {} });

/** What the UI needs of a node: no styles, no rects. Compact keys because pages have thousands of nodes. */
export interface LightNode {
  /** parent idx, -1 for the root */
  p: number;
  /** lowercase tag */
  t: string;
  /** own text, whitespace collapsed, capped */
  x: string;
  /** 0 = not in U, 1 = rendered unit of U, 2 = disclosure unit of U (collapsed content) */
  u: 0 | 1 | 2;
  /** id attribute (capped), for the node info panel */
  i?: string;
  /** class attribute (capped) */
  c?: string;
}
