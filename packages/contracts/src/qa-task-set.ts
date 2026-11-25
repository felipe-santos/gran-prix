import { Type, type Static } from "@sinclair/typebox";
import { NonNegInt, PosInt, Sha256, Unit01, contractObject, defineContract } from "./base.js";
import { SplitName } from "./dataset.js";
import { Provenance, ProvenanceDef } from "./provenance.js";

/**
 * QaTaskSet (C10): the frozen set of questions of the downstream QA study (protocol section 9). The
 * EvalReport only carries its `task_set_id`; this document IS the id's content.
 *
 * Evidence points at the snapshot units (elements) that answer the question and carries the literal quote.
 * Evidence in a `noise` element is not representable on purpose: noise is discarded by definition, and what the
 * study measures is whether the pruner dropped something the gold kept (`main` or `support`).
 */

export const QaEvidence = Type.Object({
  unit_ids: Type.Array(NonNegInt, { minItems: 1, description: "Snapshot node idx of the elements holding the evidence, strictly increasing." }),
  quote: Type.String({ minLength: 1, description: "Literal excerpt of the page text (appears exactly once in the D2 markdown)." }),
  class: Type.Union([Type.Literal("main"), Type.Literal("support")], { description: "Gold class of the evidence. `noise` is forbidden." }),
});

export const QaTask = Type.Object({
  id: Type.String({ minLength: 1 }),
  group_id: Type.String({ minLength: 1, description: "A pages[].group_id." }),
  stratum: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal("main"), Type.Literal("category"), Type.Literal("support")], {
    description: "main = about the main content; category = specific to the page category (price, parameter, ...); support = answerable from support content (date, author, breadcrumb).",
  }),
  question: Type.String({ minLength: 1 }),
  answer: Type.String({ minLength: 1, description: "Short answer, at most 20 words." }),
  answer_variants: Type.Array(Type.String({ minLength: 1 }), { description: "Other accepted surface forms of the answer." }),
  evidence: QaEvidence,
  validation: Type.Object({
    status: Type.Literal("accepted"),
    by: Type.Union([Type.Literal("human"), Type.Literal("auto")]),
    candidate_rank: Type.Optional(PosInt),
  }),
});
export type QaTask = Static<typeof QaTask>;

export const QaTaskSetContract = defineContract(
  "qa-task-set",
  "gran-prix.qa-task-set",
  "1.0.0",
  contractObject(
    "qa-task-set",
    "gran-prix.qa-task-set",
    {
      task_set_id: Sha256,
      dataset_id: Type.Optional(Sha256),
      generator: Type.Object({
        model: Type.String({ minLength: 1 }),
        prompt_sha256: Sha256,
        source: Type.String({ minLength: 1, description: "What the generator read, e.g. 'D2 full-page markdown'." }),
        converter: Type.Optional(Type.String()),
      }),
      pages: Type.Array(
        Type.Object({
          group_id: Type.String({ minLength: 1 }),
          snapshot_id: Sha256,
          stratum: Type.String({ minLength: 1 }),
          split: SplitName,
          prediction: Type.Union([Type.Literal("frozen_model"), Type.Literal("oof")], {
            description: "frozen_model = test page scored by the final model; oof = dev page scored out-of-fold (the model never saw the domain).",
          }),
        }),
        { minItems: 1 },
      ),
      tasks: Type.Array(QaTask, { minItems: 1 }),
      review: Type.Object({
        n_candidates: PosInt,
        n_accepted: NonNegInt,
        n_rejected: NonNegInt,
        rejection_rate: Unit01,
        human_reviewed: Type.Boolean({ description: "true: every accepted task was seen by a human (protocol: 100%)." }),
      }),
      provenance: Provenance,
    },
    "Question set of the downstream QA study: question, short answer and variants, evidence (units + literal quote, never noise), kind, validation, rejection rate.",
    { $defs: { Provenance: ProvenanceDef } },
  ),
);
export const QaTaskSetSchema = QaTaskSetContract.schema;
export type QaTaskSet = Static<typeof QaTaskSetSchema>;
