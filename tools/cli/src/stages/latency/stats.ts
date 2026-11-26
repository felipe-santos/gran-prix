/** Summary statistics of the latency samples. Percentiles use the nearest-rank method (no interpolation). */

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

/** Nearest rank: the smallest value with at least p% of the samples at or below it (`sorted` ascending, non-empty). */
export function nearestRank(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error("percentile of no samples");
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) throw new Error("summary of no samples");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    max: sorted[sorted.length - 1] as number,
    mean: sorted.reduce((a, v) => a + v, 0) / sorted.length,
  };
}

export const median = (values: readonly number[]): number => nearestRank([...values].sort((a, b) => a - b), 50);

/** Rounds a measurement to 0.01 ms for the report (the clock resolution of a throttled page is far coarser). */
export const ms2 = (v: number): number => Math.round(v * 100) / 100;
