import type { Estimator } from "./bootstrap.js";
import { metricOf, type Counts, type Metric } from "./metrics.js";

/**
 * Statistics over groups (pages). Every system is reduced to per-group confusion counts; an
 * estimator then aggregates a subset of groups under a vector of multiplicities (all ones for the
 * point estimate, bootstrap draws for the intervals).
 *
 *  - `micro`: counts summed over the groups (a big page weighs more), then the metric.
 *  - `macro_page`: the metric of each page (character-weighted inside the page), averaged over pages
 *    (every page weighs 1). Pages with no weight are left out. This is the primary statistic.
 */

export type Aggregation = "micro" | "macro_page";
export const AGGREGATIONS: readonly Aggregation[] = ["micro", "macro_page"];

/** Per-group weighted confusion counts of one system (index = group index). */
export interface GroupCounts {
  tp: Float64Array;
  fp: Float64Array;
  tn: Float64Array;
  fn: Float64Array;
}

export const newGroupCounts = (nGroups: number): GroupCounts => ({
  tp: new Float64Array(nGroups),
  fp: new Float64Array(nGroups),
  tn: new Float64Array(nGroups),
  fn: new Float64Array(nGroups),
});

export function countsOf(gc: GroupCounts, g: number): Counts {
  return { tp: gc.tp[g] as number, fp: gc.fp[g] as number, tn: gc.tn[g] as number, fn: gc.fn[g] as number };
}

/** Sum of the counts over a subset of groups (multiplicity 1). */
export function sumCounts(gc: GroupCounts, groups: readonly number[]): Counts {
  const c: Counts = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const g of groups) {
    c.tp += gc.tp[g] as number;
    c.fp += gc.fp[g] as number;
    c.tn += gc.tn[g] as number;
    c.fn += gc.fn[g] as number;
  }
  return c;
}

/** NaN when the subset carries no weight (nothing to average). */
export function estimator(gc: GroupCounts, groups: readonly number[], agg: Aggregation, metric: Metric): Estimator {
  if (agg === "micro") {
    return (mult) => {
      const c: Counts = { tp: 0, fp: 0, tn: 0, fn: 0 };
      for (const g of groups) {
        const m = mult[g] as number;
        if (m === 0) continue;
        c.tp += m * (gc.tp[g] as number);
        c.fp += m * (gc.fp[g] as number);
        c.tn += m * (gc.tn[g] as number);
        c.fn += m * (gc.fn[g] as number);
      }
      return c.tp + c.fp + c.tn + c.fn > 0 ? metricOf(c, metric) : NaN;
    };
  }
  return (mult) => {
    let sum = 0;
    let pages = 0;
    for (const g of groups) {
      const m = mult[g] as number;
      if (m === 0) continue;
      const c = countsOf(gc, g);
      if (c.tp + c.fp + c.tn + c.fn <= 0) continue;
      sum += m * metricOf(c, metric);
      pages += m;
    }
    return pages > 0 ? sum / pages : NaN;
  };
}

/** `a - b` on the same resample: the paired difference of two systems. */
export function pairedEstimator(a: GroupCounts, b: GroupCounts, groups: readonly number[], agg: Aggregation, metric: Metric): Estimator {
  const ea = estimator(a, groups, agg, metric);
  const eb = estimator(b, groups, agg, metric);
  return (mult) => ea(mult) - eb(mult);
}

export const ones = (n: number): Float64Array => new Float64Array(n).fill(1);
