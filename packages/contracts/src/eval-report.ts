import { Type, type Static } from "@sinclair/typebox";
import { NonNegInt, PosInt, Sha256, Unit01, contractObject, defineContract } from "./base.js";
import { SplitName } from "./dataset.js";
import { Provenance, ProvenanceDef } from "./provenance.js";
import {
  Aggregate,
  EvalNames,
  EvalSystem,
  EvidenceRetention,
  MetricCiTable,
  PrCurve,
  RuntimeBlock,
  TokenReduction,
  Weighting,
} from "./eval-parts.js";
import { BootstrapBody, Ci95, Ci95Body, Gate, GateBody, NoteBody } from "./stats.js";

/**
 * EvalReport (generic: unit / group / stratum). No timestamps in the hashed
 * payload (provenance is outside `report_id`). Bootstrap CIs resample GROUPS
 * (pages/domains), never rows: the independent unit is the group.
 */

const PrfBody = Type.Object({
  n: NonNegInt,
  tp: NonNegInt,
  fp: NonNegInt,
  tn: NonNegInt,
  fn: NonNegInt,
  precision: Unit01,
  recall: Unit01,
  f1: Unit01,
  accuracy: Unit01,
});
export type Prf = Static<typeof PrfBody>;

// Shared shapes live in `$defs` and are referenced, so the emitted schema stays small and the
// Rust side gets named types (`Prf`, `Ci95`) instead of eight anonymous copies.
export const Prf = Type.Unsafe<Prf>({ $ref: "#/$defs/Prf" });
const Arm = Type.Object({
  n: NonNegInt,
  score_mean: Type.Number(),
  score_ci95: Ci95,
  tokens_in_mean: Type.Number({ minimum: 0 }),
  cost_usd: Type.Number({ minimum: 0 }),
  evidence_retention: Type.Optional(EvidenceRetention),
});

export const COMPARISON_METRICS = ["f1", "precision", "recall", "token_f1", "qa_accuracy"] as const;

const Intrinsic = Type.Object({
  weighting: Type.Optional(Weighting),
  overall: Type.Intersect([
    Prf,
    Type.Object({
      auc_roc: Unit01,
      pr_auc: Unit01,
      logloss: Type.Number({ minimum: 0 }),
      brier: Unit01,
    }),
  ]),
  by_stratum: Type.Record(Type.String(), Type.Intersect([Prf, Type.Object({ n_groups: NonNegInt })])),
  by_label_source: Type.Record(Type.String(), Prf, {
    description: "Avoids the circularity 'trained and measured on the same labeler'. Keys = LabelSource.",
  }),
  baselines: Type.Record(
    Type.String(),
    Type.Object({
      overall: Prf,
      by_stratum: Type.Record(Type.String(), Type.Intersect([Prf, Type.Object({ n_groups: Type.Optional(NonNegInt) })])),
    }),
  ),
  comparison: Type.Array(
    Type.Object({
      stratum: Type.String(),
      metric: Type.Union(COMPARISON_METRICS.map((m) => Type.Literal(m)), {
        description: "v1.0 only had f1. `stratum` may also be an aggregate name (intrinsic.aggregates) or 'overall'.",
      }),
      model: Type.Number(),
      baseline: Type.String(),
      baseline_value: Type.Number(),
      delta: Type.Number(),
      ci95: Ci95,
      n_groups: NonNegInt,
    }),
  ),
  by_tag: Type.Optional(
    Type.Record(Type.String(), Type.Intersect([Prf, Type.Object({ n_groups: NonNegInt })]), {
      description: "Slices by Dataset.groups[].tags (logged_in, lang:pt, ...). Keys are tags.",
    }),
  ),
  aggregates: Type.Optional(Type.Array(Aggregate)),
  metric_ci: Type.Optional(MetricCiTable),
  pr_curve: Type.Optional(PrCurve),
  token_reduction: Type.Optional(TokenReduction),
  runtime: Type.Optional(RuntimeBlock),
  token_stats: Type.Optional(
    Type.Object({
      tokenizer: Type.String(),
      full_tokens: NonNegInt,
      kept_tokens: NonNegInt,
      ratio: Type.Number({ minimum: 0 }),
    }),
  ),
  per_group: Type.Array(
    Type.Object({
      group_id: Type.String(),
      stratum: Type.String(),
      f1: Unit01,
      kept_ratio: Unit01,
      group_key: Type.Optional(Type.String()),
      n_chars: Type.Optional(NonNegInt),
      f1_by_baseline: Type.Optional(Type.Record(Type.String(), Unit01)),
      tokens_d1: Type.Optional(NonNegInt),
      tokens_d2: Type.Optional(NonNegInt),
      tokens_kept: Type.Optional(NonNegInt),
    }),
  ),
  calibration: Type.Optional(
    Type.Object({
      ece: Unit01,
      bins: Type.Array(
        Type.Object({ lo: Unit01, hi: Unit01, n: NonNegInt, mean_p: Unit01, frac_pos: Unit01 }),
      ),
    }),
  ),
});

const Downstream = Type.Object({
  task_set_id: Sha256,
  llm: Type.Object({ model: Type.String(), prompt_sha256: Sha256 }),
  judge: Type.Object({
    kind: Type.Union([Type.Literal("llm"), Type.Literal("exact"), Type.Literal("human")]),
    model: Type.Optional(Type.String()),
    rubric_sha256: Type.Optional(Sha256),
    human_agreement: Type.Optional(Unit01),
  }),
  arms: Type.Record(Type.String(), Arm, { description: "e.g. full_page, pruned_model, pruned_readability." }),
  paired_deltas: Type.Array(
    Type.Object({
      a: Type.String(),
      b: Type.String(),
      mean_delta: Type.Number(),
      ci95: Ci95,
      p_value: Type.Optional(Unit01),
    }),
  ),
});

export const EvalReportContract = defineContract(
  "eval-report",
  "gran-prix.eval-report",
  "1.1.0",
  contractObject(
    "eval-report",
    "gran-prix.eval-report",
    {
      report_id: Sha256,
      mode: Type.Union([Type.Literal("intrinsic"), Type.Literal("downstream")]),
      model_id: Sha256,
      dataset_id: Sha256,
      split: Type.Union([
        SplitName,
        Type.Literal("all"),
        Type.Object({ kfold: Type.Object({ k: PosInt, fold: NonNegInt }) }),
      ]),
      threshold: Unit01,
      intrinsic: Type.Optional(Intrinsic),
      downstream: Type.Optional(Downstream),
      gates: Type.Optional(Type.Array(Gate)),
      system: Type.Optional(EvalSystem),
      names: Type.Optional(EvalNames),
      bootstrap: Type.Optional(BootstrapBody),
      notes: Type.Optional(Type.Array(NoteBody)),
      provenance: Provenance,
    },
    "Evaluation of a system on a dataset split: per-stratum metrics with CIs, baselines, PR curve, token reduction, QA arms, structured gates. v1.1 adds the optional fields that the report package used to read from a sidecar.",
    { $defs: { Prf: PrfBody, Ci95: Ci95Body, Gate: GateBody, Provenance: ProvenanceDef } },
  ),
);
export const EvalReportSchema = EvalReportContract.schema;
export type EvalReport = Static<typeof EvalReportSchema>;
