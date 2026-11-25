import type { PageSnapshot } from "@gran-prix/contracts";

/**
 * The evaluation weight of a unit (Dataset 1.1 `row_weight: "own_text_chars"`, `dataset-row.w`): the length of the
 * node's OWN text in Unicode code points (NFC, whitespace already collapsed by the probe).
 *
 * `own_text` is truncated at the probe's cap while `own_text_len` is measured before truncation (UTF-16 units). For a
 * truncated node the code points of the kept prefix are counted exactly and every cut unit counts as one code point,
 * which is exact for BMP text and an upper bound (at most 2x on the cut part) for astral characters.
 */
export function ownTextChars(node: Pick<PageSnapshot["nodes"][number], "own_text" | "own_text_len">): number {
  let cp = 0;
  for (const _ of node.own_text.normalize("NFC")) cp++;
  return cp + Math.max(0, node.own_text_len - node.own_text.length);
}

/** `unit_id` (snapshot node idx) -> weight, for every node of the snapshot. */
export function ownTextWeights(snapshot: Pick<PageSnapshot, "nodes">): Map<number, number> {
  return new Map(snapshot.nodes.map((n) => [n.idx, ownTextChars(n)]));
}
