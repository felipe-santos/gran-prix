import { Type, type Static } from "@sinclair/typebox";
import { NonNegInt, PosInt } from "./base.js";

/**
 * Statistics shapes shared by EvalReport, LabelAgreement and QaTaskSet (contracts v1.1).
 * Each contract that uses `Ci95`, `Gate` or `Bootstrap` carries the matching `$defs` entry
 * (`ci95Defs()`), so every schema file stays self-contained.
 */

/** `[lo, hi]`, lo <= hi (an invariant, not expressible in JSON Schema). */
export const Ci95Body = Type.Tuple([Type.Number(), Type.Number()], { description: "[lo, hi], lo <= hi." });
export const Ci95 = Type.Unsafe<[number, number]>({ $ref: "#/$defs/Ci95" });

export const COMPARATORS = [">=", ">", "<=", "<", "=="] as const;
export type Comparator = (typeof COMPARATORS)[number];

/**
 * A pre-registered decision rule and its outcome (v1.0: `id`, `rule`, `value`, `passed`).
 * v1.1 adds the machine-readable parts, all optional. When `comparator` and `threshold` are present the
 * validator recomputes `passed` from `value` (no gate can contradict itself).
 */
export const GateBody = Type.Object({
  id: Type.String({ minLength: 1 }),
  rule: Type.String({ description: "Human-readable rule, e.g. 'F1(MLP) - F1(best single) >= 0.05 and CI lower bound > 0'." }),
  value: Type.Number({
    description: "The number compared with `threshold`: the point estimate, or the CI bound when `use_ci_lower` is true.",
  }),
  passed: Type.Boolean(),
  name: Type.Optional(Type.String({ description: "Display name, e.g. 'G1a F1 gain on hard strata'." })),
  comparator: Type.Optional(Type.Union(COMPARATORS.map((c) => Type.Literal(c)), { description: "`value <comparator> threshold` is the passing condition." })),
  threshold: Type.Optional(Type.Number()),
  unit: Type.Optional(Type.String({ description: "Unit of value / threshold / observed: 'f1', 'pp', 'ratio', 'x', 'ms', 'bytes', 'kappa', ..." })),
  stratum: Type.Optional(Type.String({ description: "Stratum or aggregate name the gate is evaluated on (e.g. 'hard'); absent = overall." })),
  observed: Type.Optional(Type.Number({ description: "Point estimate in `unit` (the number the reader sees)." })),
  ci95: Type.Optional(Ci95),
  metric: Type.Optional(Type.String({ description: "What `value` measures: f1, recall, token_f1, qa_accuracy, kappa, token_reduction_d2, p95_ms, ..." })),
  baseline: Type.Optional(Type.String({ description: "Baseline the gate compares against, when it is a difference." })),
  aggregation: Type.Optional(Type.Union([Type.Literal("micro"), Type.Literal("macro_page"), Type.Literal("macro_stratum")])),
  use_ci_lower: Type.Optional(
    Type.Boolean({
      description: "true: the gate is decided on the CI bound facing the threshold (ci95[0] for >= and >, ci95[1] for <= and <), and `value` equals that bound.",
    }),
  ),
});
export type Gate = Static<typeof GateBody>;
export const Gate = Type.Unsafe<Gate>({ $ref: "#/$defs/Gate" });

/** Bootstrap used for every CI of a document (group-clustered, never row-level). */
export const BootstrapBody = Type.Object({
  resamples: PosInt,
  seed: NonNegInt,
  cluster_by: Type.Union([Type.Literal("group_key"), Type.Literal("group_id")], {
    description: "What is resampled: group_key (registrable domain, default of the protocol) or group_id (a page).",
  }),
  method: Type.Literal("percentile"),
  stratified: Type.Boolean({ description: "true: resampling is done inside each stratum." }),
});
export type Bootstrap = Static<typeof BootstrapBody>;

/** `$defs` entries every contract using Ci95 / Gate must carry. */
export function ci95Defs(): { Ci95: typeof Ci95Body } {
  return { Ci95: Ci95Body };
}
export function gateDefs(): { Ci95: typeof Ci95Body; Gate: typeof GateBody } {
  return { Ci95: Ci95Body, Gate: GateBody };
}

/** Free-text note or threat to validity that travels with the number (mirror of the report sidecar). */
export const NoteBody = Type.Object({
  kind: Type.Union([Type.Literal("note"), Type.Literal("threat")]),
  text: Type.String({ minLength: 1 }),
});
export type Note = Static<typeof NoteBody>;

/** Per-metric CIs of one stratum (mirror of the report sidecar `metric_ci`). */
export const MetricCisBody = Type.Object({
  precision: Type.Optional(Ci95),
  recall: Type.Optional(Ci95),
  f1: Type.Optional(Ci95),
});
export type MetricCis = Static<typeof MetricCisBody>;

/** True when `passed` is what the comparator says for `value` vs `threshold`. */
export function compare(value: number, comparator: Comparator, threshold: number): boolean {
  switch (comparator) {
    case ">=":
      return value >= threshold;
    case ">":
      return value > threshold;
    case "<=":
      return value <= threshold;
    case "<":
      return value < threshold;
    case "==":
      return value === threshold;
  }
}
