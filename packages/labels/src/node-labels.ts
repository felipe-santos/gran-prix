import {
  THREE_CLASS_SPACE,
  artifactId,
  contractId,
  type NodeLabelItem,
  type NodeLabels,
  type Sha256,
} from "@gran-prix/contracts";

/** A NodeLabels document plus the extension fields this package writes (the schema is open). */
export type NodeLabelsDoc = NodeLabels & Record<string, unknown>;

export const LABELER_VERSION = "1.0.0" as const;

export interface BuildNodeLabelsInput {
  snapshot_id: Sha256;
  labeler: Omit<NodeLabels["labeler"], "params_sha256" | "version"> & { params: unknown; version?: NodeLabels["labeler"]["version"] };
  items: readonly NodeLabelItem[];
  /** Units that could have been labeled (here: feature rows that own text). */
  n_candidates: number;
  /** Extension fields (alignment record, import stats, page identity). Part of `labels_id`. */
  extra?: Record<string, unknown>;
}

/** Builds a content-addressed NodeLabels document in the 3-class space; items are sorted by unit_id. */
export function buildNodeLabels(input: BuildNodeLabelsInput): NodeLabelsDoc {
  const items = [...input.items].sort((a, b) => a.unit_id - b.unit_id);
  for (let i = 1; i < items.length; i++) {
    if ((items[i] as NodeLabelItem).unit_id === (items[i - 1] as NodeLabelItem).unit_id) {
      throw new Error(`duplicate label for unit ${(items[i] as NodeLabelItem).unit_id}`);
    }
  }
  const { params, version, ...labelerRest } = input.labeler;
  const body = {
    format: "gran-prix.node-labels" as const,
    format_version: "1.0.0" as const,
    snapshot_id: input.snapshot_id,
    label_space: { kind: "multiclass" as const, classes: [...THREE_CLASS_SPACE.classes] },
    labeler: { ...labelerRest, version: version ?? LABELER_VERSION, params_sha256: artifactId(params) },
    items,
    coverage: { n_labeled: items.length, n_candidates: input.n_candidates },
    ...input.extra,
  };
  const labels_id = contractId("node-labels", body as unknown as Record<string, unknown>);
  return { labels_id, ...body } as NodeLabelsDoc;
}
