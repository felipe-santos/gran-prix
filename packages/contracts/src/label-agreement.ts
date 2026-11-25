import { Type, type Static } from "@sinclair/typebox";
import { NonNegInt, PosInt, Sha256, Unit01, contractObject, defineContract } from "./base.js";
import { LabelSource } from "./node-labels.js";
import { Provenance, ProvenanceDef } from "./provenance.js";
import { BootstrapBody, Ci95, Gate, NoteBody, gateDefs } from "./stats.js";

/**
 * LabelAgreement (C0): the audit of a labeler against another one (typically LLM vs human on the audited
 * pages), as Cohen's kappa. It exists so that "the LLM is good enough to be the teacher" (protocol D7) is a
 * checked, hashed artifact and not a sentence in a report.
 *
 * Counts are in `weighting` units: `elements` (one unit = one element of the universe U) or `chars` (the
 * element's own-text length). `confusion[i][j]` = units labeled class i by `a` and class j by `b`.
 * kappa = (po - pe) / (1 - pe), po = trace / n, pe = sum_k (row_k * col_k) / n^2; the validator recomputes
 * `n`, `observed_agreement`, `expected_agreement` and `kappa` from `confusion`.
 */

export const KappaResult = Type.Object({
  space: Type.Union([Type.Literal("binary"), Type.Literal("three_class")], {
    description: "binary = keep (main + support) vs drop (the one that trains); three_class = main / support / noise.",
  }),
  weighting: Type.Union([Type.Literal("elements"), Type.Literal("chars")]),
  classes: Type.Array(Type.String({ minLength: 1 }), { minItems: 2 }),
  confusion: Type.Array(Type.Array(NonNegInt), { description: "Square, classes.length x classes.length." }),
  n: NonNegInt,
  observed_agreement: Unit01,
  expected_agreement: Unit01,
  kappa: Type.Number({ minimum: -1, maximum: 1 }),
  ci95: Type.Optional(Ci95),
  n_groups: NonNegInt,
});
export type KappaResult = Static<typeof KappaResult>;

const Labeler = Type.Object({
  kind: Type.Union([LabelSource, Type.Literal("merge")]),
  version: Type.Optional(Type.String()),
  labels_ids: Type.Optional(Type.Array(Sha256, { description: "NodeLabels documents this labeler contributed to the audit." })),
});

const Pair = Type.Object({
  a: Type.String({ minLength: 1, description: "Key of `labelers`." }),
  b: Type.String({ minLength: 1, description: "Key of `labelers`." }),
  stratum: Type.String({ minLength: 1, description: "'overall' (pooled) or a stratum / aggregate name." }),
  results: Type.Array(KappaResult, { minItems: 1 }),
});

export const LabelAgreementContract = defineContract(
  "label-agreement",
  "gran-prix.label-agreement",
  "1.0.0",
  contractObject(
    "label-agreement",
    "gran-prix.label-agreement",
    {
      agreement_id: Sha256,
      dataset_id: Type.Optional(Sha256),
      guide_version: Type.Optional(Type.String({ description: "Version of the labeling guide the labelers followed." })),
      population: Type.Object({
        unit: Type.String({ minLength: 1, description: "e.g. dom-element-with-own-text (the universe U)." }),
        n_groups: PosInt,
        n_units: PosInt,
        n_chars: Type.Optional(NonNegInt),
        by_stratum: Type.Record(Type.String(), Type.Object({ n_groups: NonNegInt, n_units: NonNegInt })),
      }),
      labelers: Type.Record(Type.String(), Labeler, { minProperties: 2 }),
      pairs: Type.Array(Pair, { minItems: 1 }),
      bootstrap: Type.Optional(BootstrapBody),
      retest: Type.Optional(
        Type.Object(
          {
            labeler: Type.String({ minLength: 1 }),
            n_groups: PosInt,
            n_units: PosInt,
            interval_days: NonNegInt,
            kappa_binary: Type.Number({ minimum: -1, maximum: 1 }),
            ci95: Type.Optional(Ci95),
          },
          { description: "Test-retest of one human against their own earlier labels (blind), protocol 5.4." },
        ),
      ),
      gates: Type.Optional(Type.Array(Gate)),
      notes: Type.Optional(Type.Array(NoteBody)),
      provenance: Provenance,
    },
    "Cohen's kappa audit between labelers on the audited pages: per pair and stratum, binary and 3-class, element- and char-weighted, with group-bootstrap CIs and the gates it feeds.",
    { $defs: { ...gateDefs(), Provenance: ProvenanceDef } },
  ),
);
export const LabelAgreementSchema = LabelAgreementContract.schema;
export type LabelAgreement = Static<typeof LabelAgreementSchema>;
