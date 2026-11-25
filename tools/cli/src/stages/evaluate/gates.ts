import type { Ci, Estimator } from "./bootstrap.js";
import { type Aggregation, type GroupCounts, estimator, ones, pairedEstimator } from "./estimators.js";
import { METRICS, type Metric } from "./metrics.js";

/**
 * Gates are data, not code: each one names a metric, an optional stratum filter (pooled groups of
 * the listed strata; omitted = every group), an optional baseline (then the metric is the paired
 * difference model - baseline), a comparator and a threshold. Thresholds always come from params.
 */

export const COMPARATORS = [">=", ">", "<=", "<"] as const;
export type Comparator = (typeof COMPARATORS)[number];

export interface GateParam {
  id: string;
  /** Human name for the report (extras `gate_details`). */
  name?: string;
  metric: Metric;
  comparator: Comparator;
  threshold: number;
  /** One stratum or a list (pooled); an entry may also name an aggregate (`params.aggregates`). Omitted or "overall": all groups. */
  stratum?: string | string[];
  /** Baseline id: the observed value is the paired difference model - baseline. */
  baseline?: string;
  /** Default: the stage's `aggregation` param. */
  aggregation?: Aggregation;
  /** Judge the conservative CI bound (lower for `>`/`>=`, upper for `<`/`<=`) instead of the point estimate. */
  use_ci_lower?: boolean;
}

export const GATE_PARAM_SCHEMA = {
  type: "object",
  required: ["id", "metric", "comparator", "threshold"],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    name: { type: "string" },
    metric: { enum: [...METRICS] },
    comparator: { enum: [...COMPARATORS] },
    threshold: { type: "number" },
    stratum: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1 }] },
    baseline: { type: "string", minLength: 1 },
    aggregation: { enum: ["micro", "macro_page"] },
    use_ci_lower: { type: "boolean" },
  },
} as const;

/** What a gate needs to know about the evaluated data. */
export interface GateScope {
  /** Group indices of the listed strata (all groups when `undefined`). Throws for an unknown stratum. */
  groupsOf(strata: readonly string[] | undefined): number[];
  /** Model counts, restricted to the units a baseline covers when `baseline` is given. */
  model(baseline?: string): GroupCounts;
  /** Counts of a baseline. Throws for an unknown id. */
  baseline(id: string): GroupCounts;
}

export interface PlannedGate {
  gate: GateParam;
  aggregation: Aggregation;
  strata: string[] | undefined;
  estimate: Estimator;
}

/** Strata (or aggregate names) a gate is restricted to; `undefined` = every group. */
export const strataOf = (g: GateParam): string[] | undefined => {
  const list = g.stratum === undefined ? [] : Array.isArray(g.stratum) ? g.stratum : [g.stratum];
  const named = list.filter((s) => s !== "overall");
  return named.length > 0 ? named : undefined;
};

export function planGate(gate: GateParam, defaultAggregation: Aggregation, scope: GateScope): PlannedGate {
  const aggregation = gate.aggregation ?? defaultAggregation;
  const strata = strataOf(gate);
  let groups: number[];
  try {
    groups = scope.groupsOf(strata);
  } catch (e) {
    throw new Error(`gate "${gate.id}": ${e instanceof Error ? e.message : String(e)}`);
  }
  const estimate =
    gate.baseline === undefined
      ? estimator(scope.model(), groups, aggregation, gate.metric)
      : pairedEstimator(scope.model(gate.baseline), scope.baseline(gate.baseline), groups, aggregation, gate.metric);
  return { gate, aggregation, strata, estimate };
}

export interface GateOutcome {
  id: string;
  rule: string;
  value: number;
  passed: boolean;
  /** Point estimate and CI of the observed statistic (the extras `gate_details`). */
  point: number;
  ci95: Ci | null;
  threshold: string;
  name: string | undefined;
  /** The machine-readable parts of the gate (EvalReport 1.1 `gates[]`). */
  comparator: Comparator;
  thresholdValue: number;
  metric: Metric;
  aggregation: Aggregation;
  baseline: string | undefined;
  useCiLower: boolean;
  /** Strata the gate is evaluated on, joined with "+"; `undefined` = overall. */
  stratum: string | undefined;
}

const compare = (v: number, cmp: Comparator, t: number): boolean => (cmp === ">=" ? v >= t : cmp === ">" ? v > t : cmp === "<=" ? v <= t : v < t);

export function ruleText(p: PlannedGate): string {
  const g = p.gate;
  const what = g.baseline === undefined ? g.metric : `${g.metric}(model) - ${g.metric}(${g.baseline})`;
  const where = p.strata === undefined ? "overall" : p.strata.join("+");
  const stat = `${what} [${p.aggregation}, ${where}]`;
  const lowerSide = g.comparator === ">=" || g.comparator === ">";
  return `${g.use_ci_lower ? `ci95_${lowerSide ? "lower" : "upper"}(${stat})` : stat} ${g.comparator} ${g.threshold}`;
}

export function judgeGate(p: PlannedGate, nGroups: number, ci: Ci | null): GateOutcome {
  const point = p.estimate(ones(nGroups));
  if (!Number.isFinite(point)) throw new Error(`gate "${p.gate.id}": the selected groups carry no weight, so the gate cannot be evaluated`);
  const lowerSide = p.gate.comparator === ">=" || p.gate.comparator === ">";
  let value = point;
  if (p.gate.use_ci_lower) {
    if (ci === null) throw new Error(`gate "${p.gate.id}": use_ci_lower needs a bootstrap interval, but too few resamples were finite`);
    value = lowerSide ? ci[0] : ci[1];
  }
  return {
    id: p.gate.id,
    rule: ruleText(p),
    value,
    passed: compare(value, p.gate.comparator, p.gate.threshold),
    point,
    ci95: ci,
    threshold: `${p.gate.comparator} ${p.gate.threshold}`,
    name: p.gate.name,
    comparator: p.gate.comparator,
    thresholdValue: p.gate.threshold,
    metric: p.gate.metric,
    aggregation: p.aggregation,
    baseline: p.gate.baseline,
    useCiLower: p.gate.use_ci_lower === true,
    stratum: p.strata?.join("+"),
  };
}
