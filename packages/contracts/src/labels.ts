import type { LabelSpace, NodeLabelItem } from "./node-labels.js";

/** Read-only view of a label space: accepts both the mutable schema type and the `as const` constants below. */
export interface LabelSpaceLike {
  readonly kind: LabelSpace["kind"];
  readonly classes: readonly string[];
}

/** ADR-006 label space: main content / supporting content / noise. Index = class id. */
export const THREE_CLASS_SPACE = {
  kind: "multiclass",
  classes: ["main", "support", "noise"],
} as const satisfies LabelSpace;

/** Binary training space: 0 = drop, 1 = keep. */
export const BINARY_SPACE = { kind: "binary", classes: ["drop", "keep"] } as const satisfies LabelSpace;

/**
 * Classes that map to `keep` by default. ASSUMPTION (open question for the
 * owner): `support` (captions, bylines, ...) is kept. Pass `keepClasses` to
 * change it without relabeling anything.
 */
export const DEFAULT_KEEP_CLASSES: readonly string[] = ["main", "support"];

/**
 * Projects a class index of `from` onto the binary space (1 = keep, 0 = drop).
 * A class is "keep" iff its name is in `keepClasses`. Throws on an index that
 * is not in `from`, or when `keepClasses` names a class `from` does not have
 * (typo protection).
 */
export function projectToBinary(
  y: number,
  from: LabelSpaceLike,
  keepClasses: readonly string[] = DEFAULT_KEEP_CLASSES,
): 0 | 1 {
  if (from.kind === "binary") {
    if (y !== 0 && y !== 1) throw new RangeError(`binary label must be 0 or 1 (got ${y})`);
    return y;
  }
  const classes = from.classes;
  const unknown = keepClasses.filter((c) => !classes.includes(c));
  if (unknown.length > 0) throw new RangeError(`keepClasses not in label space: ${unknown.join(", ")}`);
  const name = classes[y];
  if (name === undefined) throw new RangeError(`label index ${y} outside label space (${classes.length} classes)`);
  return keepClasses.includes(name) ? 1 : 0;
}

/** Projects every item of a NodeLabels `items` array; other fields (confidence, source, reason) are preserved. */
export function projectItemsToBinary(
  items: readonly NodeLabelItem[],
  from: LabelSpaceLike,
  keepClasses: readonly string[] = DEFAULT_KEEP_CLASSES,
): NodeLabelItem[] {
  return items.map((it) => ({ ...it, y: projectToBinary(it.y, from, keepClasses) }));
}
