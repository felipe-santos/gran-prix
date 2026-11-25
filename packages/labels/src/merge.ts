import { artifactId, canonicalJson, contractId, type LabelSource, type NodeLabelItem, type NodeLabels } from "@gran-prix/contracts";
import { LABELER_VERSION, type NodeLabelsDoc } from "./node-labels.js";

/**
 * Fixed precedence when several labelers speak about the same unit, strongest first:
 * human > user_feedback > llm > the heuristic tier (readability > heuristic > rule).
 * The winner keeps its own `source`, confidence and reason, so every label records who said it.
 */
export const SOURCE_PRECEDENCE: readonly LabelSource[] = ["human", "user_feedback", "llm", "readability", "heuristic", "rule"];

const rank = (s: LabelSource): number => SOURCE_PRECEDENCE.indexOf(s);

/**
 * Merges layers of labels of ONE snapshot (same label space). Per unit the item with the best source
 * rank wins; ties go to the higher confidence, then to the earlier layer. Units labeled by one layer
 * only pass through. The result is a `merge` NodeLabels whose `labeler.inputs` are the layer ids.
 */
export function mergeLabels(layers: readonly NodeLabels[]): NodeLabelsDoc {
  const first = layers[0];
  if (!first) throw new Error("mergeLabels needs at least one layer");
  const space = canonicalJson(first.label_space);
  for (const l of layers) {
    if (l.snapshot_id !== first.snapshot_id) throw new Error(`cannot merge labels of different snapshots (${first.snapshot_id} vs ${l.snapshot_id})`);
    if (canonicalJson(l.label_space) !== space) throw new Error("cannot merge labels of different label spaces");
  }
  const best = new Map<number, { item: NodeLabelItem; layer: number }>();
  layers.forEach((l, layer) => {
    for (const item of l.items) {
      const cur = best.get(item.unit_id);
      if (!cur) {
        best.set(item.unit_id, { item, layer });
        continue;
      }
      const dr = rank(item.source) - rank(cur.item.source);
      if (dr < 0 || (dr === 0 && item.confidence > cur.item.confidence)) best.set(item.unit_id, { item, layer });
    }
  });
  const items = [...best.values()].map((b) => b.item).sort((a, b) => a.unit_id - b.unit_id);
  const body = {
    format: "gran-prix.node-labels" as const,
    format_version: "1.0.0" as const,
    snapshot_id: first.snapshot_id,
    label_space: first.label_space,
    labeler: {
      id: `merge@${LABELER_VERSION}`,
      kind: "merge" as const,
      version: LABELER_VERSION,
      params_sha256: artifactId({ precedence: SOURCE_PRECEDENCE }),
      inputs: layers.map((l) => l.labels_id),
    },
    items,
    coverage: { n_labeled: items.length, n_candidates: Math.max(...layers.map((l) => l.coverage.n_candidates)) },
  };
  const labels_id = contractId("node-labels", body as unknown as Record<string, unknown>);
  return { labels_id, ...body } as NodeLabelsDoc;
}
