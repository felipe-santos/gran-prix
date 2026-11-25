import { Type, type Static } from "@sinclair/typebox";
import { NonNegInt, SemVer, Sha256, Unit01, contractObject, defineContract } from "./base.js";

/**
 * NodeLabels (DOM-specific unit ids; the label machinery itself is generic).
 *
 * ADR-006: label in 3 classes (main / support / noise), TRAIN binary
 * (keep / drop). `projectToBinary` in `labels.ts` is the single place where
 * the 3 -> 2 collapse is defined.
 */

export const LabelSource = Type.Union([
  Type.Literal("rule"),
  Type.Literal("heuristic"),
  Type.Literal("readability"),
  Type.Literal("llm"),
  Type.Literal("human"),
  Type.Literal("user_feedback"),
]);
export type LabelSource = Static<typeof LabelSource>;
export const LABEL_SOURCES = ["rule", "heuristic", "readability", "llm", "human", "user_feedback"] as const satisfies readonly LabelSource[];

export const LabelSpace = Type.Union([
  Type.Object({ kind: Type.Literal("binary"), classes: Type.Tuple([Type.Literal("drop"), Type.Literal("keep")]) }),
  Type.Object({ kind: Type.Literal("multiclass"), classes: Type.Array(Type.String({ minLength: 1 }), { minItems: 2 }) }),
]);
export type LabelSpace = Static<typeof LabelSpace>;

export const NodeLabelItem = Type.Object({
  unit_id: NonNegInt,
  y: NonNegInt,
  confidence: Unit01,
  source: LabelSource,
  reason: Type.Optional(Type.String()),
});
export type NodeLabelItem = Static<typeof NodeLabelItem>;

export const NodeLabelsContract = defineContract(
  "node-labels",
  "gran-prix.node-labels",
  "1.0.0",
  contractObject(
    "node-labels",
    "gran-prix.node-labels",
    {
      labels_id: Sha256,
      snapshot_id: Sha256,
      label_space: LabelSpace,
      labeler: Type.Object({
        id: Type.String({ minLength: 1, description: 'e.g. "readability@2.0", "merge@1".' }),
        kind: Type.Union([LabelSource, Type.Literal("merge")]),
        version: SemVer,
        params_sha256: Sha256,
        inputs: Type.Optional(Type.Array(Sha256, { description: "merge: labels_id of each layer." })),
        llm: Type.Optional(
          Type.Object({
            model: Type.String({ minLength: 1 }),
            prompt_id: Type.String(),
            prompt_sha256: Sha256,
            temperature: Type.Literal(0),
            response_cache_keys: Type.Array(Sha256),
          }),
        ),
      }),
      items: Type.Array(NodeLabelItem, { description: "Sorted by unit_id, unique. May be partial." }),
      coverage: Type.Object({ n_labeled: NonNegInt, n_candidates: NonNegInt }),
    },
    "Labels of one snapshot from one labeler (or a merge of labelers). confidence = P(label correct), not a model score.",
  ),
);
export const NodeLabelsSchema = NodeLabelsContract.schema;
export type NodeLabels = Static<typeof NodeLabelsSchema>;
