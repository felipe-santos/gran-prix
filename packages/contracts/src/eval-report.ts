import { Type, type Static } from "@sinclair/typebox";
import { NonNegInt, PosInt, Sha256, Unit01, contractObject, defineContract } from "./base.js";
import { SplitName } from "./dataset.js";
import { Provenance, ProvenanceDef } from "./provenance.js";

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
const Ci95Body = Type.Tuple([Type.Number(), Type.Number()], { description: "[lo, hi], lo <= hi." });
export const Prf = Type.Unsafe<Prf>({ $ref: "#/$defs/Prf" });
const Ci95 = Type.Unsafe<[number, number]>({ $ref: "#/$defs/Ci95" });
const Arm = Type.Object({
  n: NonNegInt,
  score_mean: Type.Number(),
  score_ci95: Ci95,
  tokens_in_mean: Type.Number({ minimum: 0 }),
  cost_usd: Type.Number({ minimum: 0 }),
});

const Intrinsic = Type.Object({
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
    Type.Object({ overall: Prf, by_stratum: Type.Record(Type.String(), Prf) }),
  ),
  comparison: Type.Array(
    Type.Object({
      stratum: Type.String(),
      metric: Type.Literal("f1"),
      model: Type.Number(),
      baseline: Type.String(),
      baseline_value: Type.Number(),
      delta: Type.Number(),
      ci95: Ci95,
      n_groups: NonNegInt,
    }),
  ),
  token_stats: Type.Optional(
    Type.Object({
      tokenizer: Type.String(),
      full_tokens: NonNegInt,
      kept_tokens: NonNegInt,
      ratio: Type.Number({ minimum: 0 }),
    }),
  ),
  per_group: Type.Array(
    Type.Object({ group_id: Type.String(), stratum: Type.String(), f1: Unit01, kept_ratio: Unit01 }),
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
  "1.0.0",
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
      gates: Type.Optional(
        Type.Array(Type.Object({ id: Type.String({ minLength: 1 }), rule: Type.String(), value: Type.Number(), passed: Type.Boolean() })),
      ),
      provenance: Provenance,
    },
    "Evaluation of a model on a dataset split: per-stratum metrics, baselines, group-bootstrap CIs, gates.",
    { $defs: { Prf: PrfBody, Ci95: Ci95Body, Provenance: ProvenanceDef } },
  ),
);
export const EvalReportSchema = EvalReportContract.schema;
export type EvalReport = Static<typeof EvalReportSchema>;
