import type { EvalReport } from "@gran-prix/contracts";
import { clusterBootstrap, type Ci, type Cluster, type Estimator } from "./bootstrap.js";
import {
  AGGREGATIONS,
  newGroupCounts,
  ones,
  estimator,
  pairedEstimator,
  sumCounts,
  countsOf,
  type Aggregation,
  type GroupCounts,
} from "./estimators.js";
import { judgeGate, planGate, strataOf, type GateOutcome, type GateParam, type GateScope } from "./gates.js";
import { addCount, aucRoc, brier, calibration, emptyCounts, logloss, metricOf, prAuc, prPoints, prfOf, type Metric, type Scored } from "./metrics.js";
import type { ReportExtras } from "@gran-prix/report";

/**
 * The numeric core of `ts:evaluate.intrinsic`: scored rows in, the EvalReport v1.1 `intrinsic` section, structured
 * gates and notes, the legacy extras sidecar and a details document out. No I/O and no model: the caller scores.
 */

export type Intrinsic = NonNullable<EvalReport["intrinsic"]>;
export type ReportWeighting = NonNullable<Intrinsic["weighting"]>;
export type ReportGate = NonNullable<EvalReport["gates"]>[number];
export type ReportNote = NonNullable<EvalReport["notes"]>[number];

export interface GroupInfo {
  id: string;
  /** Registrable domain (the bootstrap cluster by default). */
  key: string;
  stratum: string;
  /** `Dataset.groups[].tags` (slices such as `lang:pt`). */
  tags?: readonly string[];
}

/** A named set of strata (the protocol's "hard"): reported in `intrinsic.aggregates[]`, usable as a gate or comparison stratum. */
export interface AggregateDef {
  name: string;
  strata: readonly string[];
}

export interface ScoredRow {
  /** Index into `groups`. */
  g: number;
  u: number;
  y: 0 | 1;
  /** Label source of the row (`LabelSource`). */
  s: string;
  /** Weight: characters of own text, or 1. */
  w: number;
  /** P(keep). */
  score: number;
}

export interface BaselineInput {
  id: string;
  /** Predicted keep per unit key (`g` NUL `u`); units not listed are not covered. */
  keep: ReadonlyMap<string, boolean>;
  /** Where the predictions come from (goes into the notes). */
  origin?: string;
}

export interface CoreOptions {
  threshold: number;
  seed: number;
  resamples: number;
  clusterBy: "group_key" | "group_id";
  stratified: boolean;
  /** Statistic of `comparison[]` and of gates that do not name one. */
  aggregation: Aggregation;
  gates: readonly GateParam[];
  /** Number of evenly spaced thresholds of the PR curve (the operating threshold is always added). */
  prGrid: number;
  /** Notes the caller wants first (weighting, threshold, ...). */
  notes?: ReportExtras["notes"];
  /** What one count is (`intrinsic.weighting`). */
  weighting?: ReportWeighting;
  /** Named strata sets; a gate that pools several strata adds one named after them (joined with "+"). */
  aggregates?: readonly AggregateDef[];
  /** `intrinsic.pr_curve.operating_rule`. */
  operatingRule?: string;
}

export interface CoreResult {
  intrinsic: Intrinsic;
  gates: ReportGate[];
  notes: ReportNote[];
  extras: ReportExtras;
  details: Record<string, unknown>;
}

export const unitKeyOf = (groupId: string, u: number): string => `${groupId}\u0000${u}`;

const SMALL_STRATUM = 10;
const PRF_METRICS = ["precision", "recall", "f1"] as const satisfies readonly Metric[];

interface Active {
  all: number[];
  strata: string[];
  byStratum: Map<string, number[]>;
}

function activeGroups(groups: readonly GroupInfo[], rows: readonly ScoredRow[]): Active {
  const has = new Set<number>(rows.map((r) => r.g));
  const all = [...has].sort((a, b) => a - b);
  const byStratum = new Map<string, number[]>();
  for (const g of all) {
    const s = (groups[g] as GroupInfo).stratum;
    const list = byStratum.get(s);
    if (list) list.push(g);
    else byStratum.set(s, [g]);
  }
  return { all, strata: [...byStratum.keys()].sort(), byStratum };
}

/** The declared aggregates plus one per gate that pools several strata, checked against the strata of the split. */
function resolveAggregates(opts: CoreOptions, act: Active): AggregateDef[] {
  const defs = new Map<string, AggregateDef>();
  for (const a of opts.aggregates ?? []) {
    if (a.name === "overall" || act.byStratum.has(a.name)) throw new Error(`aggregate "${a.name}" clashes with a stratum name`);
    if (defs.has(a.name)) throw new Error(`aggregate "${a.name}" is declared twice`);
    defs.set(a.name, a);
  }
  const expand = (names: readonly string[]): string[] => [...new Set(names.flatMap((n) => defs.get(n)?.strata ?? [n]))].sort();
  for (const g of opts.gates) {
    const names = strataOf(g);
    if (names !== undefined && names.length > 1 && !defs.has(names.join("+"))) defs.set(names.join("+"), { name: names.join("+"), strata: expand(names) });
  }
  for (const a of defs.values()) {
    const unknown = a.strata.filter((s) => !act.byStratum.has(s));
    if (unknown.length > 0) throw new Error(`aggregate "${a.name}": unknown stratum ${unknown.map((s) => `"${s}"`).join(", ")} (this split has: ${act.strata.join(", ")})`);
  }
  return [...defs.values()].map((a) => ({ name: a.name, strata: expand(a.strata) }));
}

export function evaluateCore(input: { groups: readonly GroupInfo[]; rows: readonly ScoredRow[]; baselines: readonly BaselineInput[] }, opts: CoreOptions): CoreResult {
  const { groups, rows, baselines } = input;
  if (rows.length === 0) throw new Error("the evaluated split has no rows");
  const nG = groups.length;
  const act = activeGroups(groups, rows);
  const aggDefs = resolveAggregates(opts, act);
  const aggByName = new Map(aggDefs.map((a) => [a.name, a]));
  const reportScopes = ["overall", ...act.strata];
  const scopes = [...reportScopes, ...aggDefs.map((a) => a.name)];
  const stratumGroups = (strata: readonly string[]): number[] => strata.flatMap((s) => act.byStratum.get(s) as number[]).sort((a, b) => a - b);
  const scopeGroups = (s: string): number[] => (s === "overall" ? act.all : aggByName.has(s) ? stratumGroups((aggByName.get(s) as AggregateDef).strata) : (act.byStratum.get(s) as number[]));

  // ---- per-group confusion counts of the model, of every baseline, and of the model on each baseline's covered units
  const model = newGroupCounts(nG);
  const base = new Map(baselines.map((b) => [b.id, newGroupCounts(nG)]));
  const modelOn = new Map(baselines.map((b) => [b.id, newGroupCounts(nG)]));
  const coverage = new Map(baselines.map((b) => [b.id, { units: 0, covered: 0, weight: 0, coveredWeight: 0 }]));
  const groupWeight = new Float64Array(nG);
  const bySource = new Map<string, ReturnType<typeof emptyCounts>>();
  const put = (gc: GroupCounts, g: number, y: number, pred: boolean, w: number): void => {
    const arr = y === 1 ? (pred ? gc.tp : gc.fn) : pred ? gc.fp : gc.tn;
    arr[g] = (arr[g] as number) + w;
  };
  for (const r of rows) {
    const pred = r.score >= opts.threshold;
    put(model, r.g, r.y, pred, r.w);
    groupWeight[r.g] = (groupWeight[r.g] as number) + r.w;
    const src = bySource.get(r.s) ?? emptyCounts();
    addCount(src, r.y, pred, r.w);
    bySource.set(r.s, src);
    const gid = (groups[r.g] as GroupInfo).id;
    for (const b of baselines) {
      const cov = coverage.get(b.id) as { units: number; covered: number; weight: number; coveredWeight: number };
      cov.units += 1;
      cov.weight += r.w;
      const keep = b.keep.get(unitKeyOf(gid, r.u));
      if (keep === undefined) continue;
      cov.covered += 1;
      cov.coveredWeight += r.w;
      put(base.get(b.id) as GroupCounts, r.g, r.y, keep, r.w);
      put(modelOn.get(b.id) as GroupCounts, r.g, r.y, pred, r.w);
    }
  }
  const systems = [{ id: "model", gc: model }, ...baselines.map((b) => ({ id: b.id, gc: base.get(b.id) as GroupCounts }))];

  // ---- estimators: aggregates per system/scope, paired differences, gates
  const est = new Map<string, Estimator>();
  const kAgg = (sys: string, scope: string, agg: Aggregation, m: Metric): string => `agg|${sys}|${scope}|${agg}|${m}`;
  const kDelta = (b: string, scope: string, agg: Aggregation): string => `delta|${b}|${scope}|${agg}`;
  for (const sys of systems)
    for (const scope of scopes)
      for (const agg of AGGREGATIONS)
        for (const m of PRF_METRICS) est.set(kAgg(sys.id, scope, agg, m), estimator(sys.gc, scopeGroups(scope), agg, m));
  for (const b of baselines)
    for (const scope of scopes)
      for (const agg of AGGREGATIONS) est.set(kDelta(b.id, scope, agg), pairedEstimator(modelOn.get(b.id) as GroupCounts, base.get(b.id) as GroupCounts, scopeGroups(scope), agg, "f1"));

  const gateScope: GateScope = {
    groupsOf: (strata) => {
      if (strata === undefined) return act.all;
      const named = [...new Set(strata.flatMap((s) => aggByName.get(s)?.strata ?? [s]))];
      const unknown = named.filter((s) => !act.byStratum.has(s));
      if (unknown.length > 0) throw new Error(`unknown stratum ${unknown.map((s) => `"${s}"`).join(", ")} (this split has: ${act.strata.join(", ")})`);
      return stratumGroups(named);
    },
    model: (b) => (b === undefined ? model : (modelOn.get(b) ?? failBaseline(b, baselines))),
    baseline: (b) => base.get(b) ?? failBaseline(b, baselines),
  };
  const planned = opts.gates.map((g) => planGate(g, opts.aggregation, gateScope));
  planned.forEach((p) => est.set(`gate|${p.gate.id}`, p.estimate));

  // ---- bootstrap: clusters = registrable domains (or pages), redrawn whole, within strata
  const clusterMap = new Map<string, number[]>();
  for (const g of act.all) {
    const info = groups[g] as GroupInfo;
    const k = opts.clusterBy === "group_key" ? info.key : info.id;
    const list = clusterMap.get(k);
    if (list) list.push(g);
    else clusterMap.set(k, [g]);
  }
  // The canonical bootstrap (@gran-prix/stats) fixes the order of strata and clusters itself, by (stratum, key).
  const clusters: Cluster[] = [...clusterMap.keys()].map((k) => {
    const gs = clusterMap.get(k) as number[];
    return { stratum: (groups[gs[0] as number] as GroupInfo).stratum, key: k, groups: gs };
  });
  const cis = clusterBootstrap({ clusters, nGroups: nG, estimators: est, resamples: opts.resamples, seed: opts.seed, stratified: opts.stratified });
  const one = ones(nG);
  const point = (key: string): number => (est.get(key) as Estimator)(one);
  const ciOf = (key: string): Ci | null => cis.get(key) ?? null;
  const fin = (v: number): number => (Number.isFinite(v) ? v : 0);

  // ---- contract section
  const scored: Scored[] = rows.map((r) => ({ score: r.score, y: r.y, w: r.w }));
  const overallCounts = sumCounts(model, act.all);
  const cal = calibration(scored);
  const metricCi = (sys: string): Record<string, { precision?: Ci; recall?: Ci; f1?: Ci }> =>
    Object.fromEntries(
      reportScopes.map((scope) => {
        const o: { precision?: Ci; recall?: Ci; f1?: Ci } = {};
        for (const m of PRF_METRICS) {
          const ci = ciOf(kAgg(sys, scope, "micro", m));
          if (ci) o[m] = ci;
        }
        return [scope, o];
      }),
    );
  const grid = Array.from({ length: opts.prGrid }, (_, i) => i / (opts.prGrid - 1));
  const curve = prPoints(scored, [...new Set([...grid, opts.threshold])]);
  const covFraction = (b: BaselineInput): number => {
    const c = coverage.get(b.id) as { units: number; covered: number; weight: number; coveredWeight: number };
    return c.weight > 0 ? c.coveredWeight / c.weight : c.units > 0 ? c.covered / c.units : 0;
  };
  const tagNames = [...new Set(groups.flatMap((g) => g.tags ?? []))].sort();
  const macroStratumF1 = (gc: GroupCounts, strata: readonly string[]): number => {
    const f = strata.map((s) => sumCounts(gc, act.byStratum.get(s) as number[])).filter((c) => c.tp + c.fp + c.tn + c.fn > 0).map((c) => metricOf(c, "f1"));
    return f.length > 0 ? f.reduce((a, b) => a + b, 0) / f.length : 0;
  };
  const intrinsic: Intrinsic = {
    ...(opts.weighting ? { weighting: opts.weighting } : {}),
    bootstrap: { resamples: opts.resamples, seed: opts.seed, cluster_by: opts.clusterBy, method: "percentile", stratified: opts.stratified },
    overall: { ...prfOf(overallCounts), auc_roc: aucRoc(scored), pr_auc: prAuc(scored), logloss: logloss(scored), brier: brier(scored) },
    by_stratum: Object.fromEntries(act.strata.map((s) => [s, { ...prfOf(sumCounts(model, scopeGroups(s))), n_groups: scopeGroups(s).length }])),
    by_label_source: Object.fromEntries([...bySource.keys()].sort().map((s) => [s, prfOf(bySource.get(s) as ReturnType<typeof emptyCounts>)])),
    baselines: Object.fromEntries(
      baselines.map((b) => {
        const gc = base.get(b.id) as GroupCounts;
        return [b.id, { coverage: covFraction(b), overall: prfOf(sumCounts(gc, act.all)), by_stratum: Object.fromEntries(act.strata.map((s) => [s, prfOf(sumCounts(gc, scopeGroups(s)))])) }];
      }),
    ),
    comparison: [],
    ...(tagNames.length > 0
      ? {
          by_tag: Object.fromEntries(
            tagNames.flatMap((t) => {
              const gs = act.all.filter((g) => (groups[g] as GroupInfo).tags?.includes(t));
              return gs.length > 0 ? [[t, { ...prfOf(sumCounts(model, gs)), n_groups: gs.length }] as const] : [];
            }),
          ),
        }
      : {}),
    ...(aggDefs.length > 0
      ? {
          aggregates: aggDefs.map((a) => {
            const ci = ciOf(kAgg("model", a.name, opts.aggregation, "f1"));
            return {
              name: a.name,
              strata: [...a.strata],
              micro: prfOf(sumCounts(model, scopeGroups(a.name))),
              macro_page_f1: fin(point(kAgg("model", a.name, "macro_page", "f1"))),
              macro_stratum_f1: macroStratumF1(model, a.strata),
              ...(ci ? { ci95: ci } : {}),
            };
          }),
        }
      : {}),
    metric_ci: { model: metricCi("model"), ...(baselines.length > 0 ? { baselines: Object.fromEntries(baselines.map((b) => [b.id, metricCi(b.id)])) } : {}) },
    ...(curve.length >= 2 ? { pr_curve: { points: curve, operating_threshold: opts.threshold, ...(opts.operatingRule ? { operating_rule: opts.operatingRule } : {}) } } : {}),
    per_group: act.all.map((g) => {
      const c = countsOf(model, g);
      const total = c.tp + c.fp + c.tn + c.fn;
      const f1By = Object.fromEntries(
        baselines.flatMap((b) => {
          const bc = countsOf(base.get(b.id) as GroupCounts, g);
          return bc.tp + bc.fp + bc.tn + bc.fn > 0 ? [[b.id, metricOf(bc, "f1")] as const] : [];
        }),
      );
      return {
        group_id: (groups[g] as GroupInfo).id,
        stratum: (groups[g] as GroupInfo).stratum,
        f1: metricOf(c, "f1"),
        kept_ratio: total > 0 ? (c.tp + c.fp) / total : 0,
        group_key: (groups[g] as GroupInfo).key,
        ...(opts.weighting?.unit === "chars" ? { n_chars: groupWeight[g] as number } : {}),
        ...(Object.keys(f1By).length > 0 ? { f1_by_baseline: f1By } : {}),
      };
    }),
    calibration: cal,
  };
  const dropped: string[] = [];
  for (const b of baselines) {
    for (const s of scopes) {
      const bc = sumCounts(modelOn.get(b.id) as GroupCounts, scopeGroups(s));
      if (bc.tp + bc.fp + bc.tn + bc.fn <= 0) continue; // the baseline covers nothing here
      const ci = ciOf(kDelta(b.id, s, opts.aggregation));
      if (ci === null) {
        dropped.push(`${b.id}/${s}`);
        continue;
      }
      const m = fin(estimator(modelOn.get(b.id) as GroupCounts, scopeGroups(s), opts.aggregation, "f1")(one));
      const bv = fin(point(kAgg(b.id, s, opts.aggregation, "f1")));
      intrinsic.comparison.push({ stratum: s, metric: "f1", model: m, baseline: b.id, baseline_value: bv, delta: m - bv, ci95: ci, n_groups: scopeGroups(s).filter((g) => countsTotal(modelOn.get(b.id) as GroupCounts, g) > 0).length, aggregation: opts.aggregation });
    }
  }

  // ---- gates
  const outcomes = planned.map((p) => judgeGate(p, nG, ciOf(`gate|${p.gate.id}`)));

  // ---- notes (report.notes and the extras sidecar)
  const notes: ReportNote[] = [...(opts.notes ?? [])];
  notes.push({
    kind: "note",
    text: `Per-stratum and overall P/R/F1 in the report are MICRO (counts summed over pages). comparison[] and the default gate statistic use "${opts.aggregation}"${opts.aggregation === "macro_page" ? ": the F1 of each page, averaged over pages (every page weighs 1)" : ""}. Both aggregations are in the details document; aggregates[].ci95 is the interval of that same statistic.`,
  });
  notes.push({
    kind: "note",
    text: `Confidence intervals: ${opts.resamples} percentile bootstrap resamples, seed ${opts.seed} (numpy default_rng stream, canonical order of strata and clusters), clustered by ${opts.clusterBy} (${clusters.length} clusters of ${act.all.length} groups)${opts.stratified ? ", redrawn within strata" : ""}. Differences are paired (same resample for both systems). metric_ci is the interval of the MICRO metric.`,
  });
  for (const b of baselines) {
    const c = coverage.get(b.id) as { units: number; covered: number; weight: number; coveredWeight: number };
    notes.push({
      kind: "note",
      text: `Baseline "${b.id}"${b.origin ? ` (${b.origin})` : ""} covers ${c.covered} of ${c.units} units (${pct(c.coveredWeight, c.weight)} of the weight; baselines[].coverage is that weight share); its metrics and every paired difference use the covered units only, for the model as well.`,
    });
  }
  const small = act.strata.filter((s) => scopeGroups(s).length < SMALL_STRATUM);
  if (small.length > 0) {
    notes.push({ kind: "threat", text: `Strata with fewer than ${SMALL_STRATUM} groups (${small.map((s) => `${s}: ${scopeGroups(s).length}`).join(", ")}): their intervals are descriptive only.` });
  }
  if (dropped.length > 0) notes.push({ kind: "threat", text: `No interval could be computed for ${dropped.join(", ")}; those comparisons are left out of the report.` });
  if (intrinsic.overall.auc_roc === 0.5 && (overallCounts.tp + overallCounts.fn === 0 || overallCounts.fp + overallCounts.tn === 0)) {
    notes.push({ kind: "threat", text: "Only one class has weight in this split: AUC is reported as 0.5 (undefined) and the PR AUC is 0 or degenerate." });
  }

  // ---- extras sidecar (matches @gran-prix/report's ReportExtras; redundant with the report since 1.1) and details
  const extras: ReportExtras = {
    metric_ci: intrinsic.metric_ci as NonNullable<ReportExtras["metric_ci"]>,
    ...(curve.length >= 2 ? { pr_curve: { points: curve } } : {}),
    ...(outcomes.length > 0
      ? {
          gate_details: Object.fromEntries(
            outcomes.map((o) => [o.id, { ...(o.name ? { name: o.name } : {}), threshold: o.threshold, ...(o.ci95 ? { ci95: o.ci95 } : {}) }]),
          ),
        }
      : {}),
    notes,
  };

  const agg = (sys: string, scope: string): Record<string, unknown> =>
    Object.fromEntries(
      AGGREGATIONS.map((a) => [a, Object.fromEntries(PRF_METRICS.map((m) => [m, { value: fin(point(kAgg(sys, scope, a, m))), ci95: ciOf(kAgg(sys, scope, a, m)) }]))]),
    );
  const details = {
    format: "gran-prix.evaluate-details",
    format_version: "1.0.0",
    aggregation: opts.aggregation,
    bootstrap: { ...intrinsic.bootstrap, level: 0.95, n_clusters: clusters.length },
    groups: { n: act.all.length, by_stratum: Object.fromEntries(act.strata.map((s) => [s, scopeGroups(s).length])) },
    aggregates: Object.fromEntries(scopes.map((scope) => [scope, Object.fromEntries(systems.map((sys) => [sys.id, agg(sys.id, scope)]))])),
    paired: baselines.flatMap((b) =>
      scopes.flatMap((scope) =>
        AGGREGATIONS.map((a) => ({
          baseline: b.id,
          scope,
          aggregation: a,
          f1_model: fin(estimator(modelOn.get(b.id) as GroupCounts, scopeGroups(scope), a, "f1")(one)),
          f1_baseline: fin(point(kAgg(b.id, scope, a, "f1"))),
          delta: fin(point(kDelta(b.id, scope, a))),
          ci95: ciOf(kDelta(b.id, scope, a)),
          n_groups: scopeGroups(scope).length,
        })),
      ),
    ),
    coverage: Object.fromEntries(baselines.map((b) => [b.id, coverage.get(b.id)])),
  };

  return { intrinsic, gates: outcomes.map(gateOf), notes, extras, details };
}

/** The EvalReport 1.1 gate: the v1.0 fields plus everything a reader needs to recompute `passed`. */
function gateOf(o: GateOutcome): ReportGate {
  return {
    id: o.id,
    rule: o.rule,
    value: o.value,
    passed: o.passed,
    ...(o.name ? { name: o.name } : {}),
    comparator: o.comparator,
    threshold: o.thresholdValue,
    unit: o.metric,
    ...(o.stratum ? { stratum: o.stratum } : {}),
    observed: o.point,
    ...(o.ci95 ? { ci95: o.ci95 } : {}),
    metric: o.metric,
    ...(o.baseline ? { baseline: o.baseline } : {}),
    aggregation: o.aggregation,
    ...(o.useCiLower ? { use_ci_lower: true } : {}),
  };
}

function failBaseline(id: string, baselines: readonly BaselineInput[]): never {
  throw new Error(`unknown baseline "${id}" (available: ${baselines.map((b) => b.id).join(", ") || "none"})`);
}

/** Weight of group `g` in `gc`: > 0 when the system has something to say about the page. */
const countsTotal = (gc: GroupCounts, g: number): number => (gc.tp[g] as number) + (gc.fp[g] as number) + (gc.tn[g] as number) + (gc.fn[g] as number);

const pct = (a: number, b: number): string => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
