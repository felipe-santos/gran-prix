import { clusterMeanDraws, percentileCi } from "@gran-prix/stats";

/**
 * The statistics of the QA study (protocol 9, "Estatistica"): the paired difference per question with the bootstrap
 * that resamples DOMAINS whole (the canonical one of `@gran-prix/stats`: numpy's `default_rng(seed)`, one
 * `integers(0, n, n)` call per replicate, the statistic the mean over all the questions drawn), and McNemar's exact
 * test as an informative p-value.
 */

export const DEFAULT_RESAMPLES = 10_000;
/** The semente of protocol section 13. */
export const DEFAULT_SEED = 20261125;

export interface BootstrapConfig {
  resamples: number;
  seed: number;
}

/** Registrable domain of a group id (`<group_key>#<snapshot hex12>`). */
export function groupKeyOf(groupId: string): string {
  const at = groupId.lastIndexOf("#");
  return at < 0 ? groupId : groupId.slice(0, at);
}

export interface Interval {
  mean: number;
  /** Percentile interval of the cluster bootstrap. */
  ci95: [number, number];
}

/** Mean of `values` with its 95% interval from resampling the clusters `keys` whole. */
export function clusterMeanCi(values: readonly number[], keys: readonly string[], cfg: BootstrapConfig): Interval {
  if (values.length === 0) throw new RangeError("nothing to estimate");
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const draws = clusterMeanDraws({ values, keys, resamples: cfg.resamples, seed: cfg.seed, stratified: false });
  const ci = percentileCi(Array.from(draws), cfg.resamples, 0.95);
  return { mean, ci95: ci ?? [mean, mean] };
}

/** `log(n choose k)` through a log-gamma free recurrence (exact enough for n in the thousands). */
function logChoose(n: number, k: number): number {
  let s = 0;
  const kk = Math.min(k, n - k);
  for (let i = 1; i <= kk; i++) s += Math.log(n - kk + i) - Math.log(i);
  return s;
}

/**
 * McNemar's exact test: `a` = pairs where only the first system is right, `b` = pairs where only the second is right
 * (the concordant pairs carry no information). Two-sided, `min(1, 2 P(X <= min(a, b)))` with X ~ Binomial(a + b, 1/2);
 * 1 when there is no discordant pair.
 */
export function mcnemarExact(a: number, b: number): number {
  const n = a + b;
  if (n === 0) return 1;
  const k = Math.min(a, b);
  let p = 0;
  for (let i = 0; i <= k; i++) p += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * p);
}

export interface PairedResult {
  n: number;
  /** Mean of (a - b) over the paired questions, in fractions (0.03 = 3 pp). */
  mean_delta: number;
  ci95: [number, number];
  p_value: number;
  /** Discordant pairs: only a right, only b right. */
  only_a: number;
  only_b: number;
}

/** Paired delta of two 0/1 vectors (same questions, same order) with its cluster-bootstrap interval and McNemar's p. */
export function pairedDelta(a: readonly (0 | 1)[], b: readonly (0 | 1)[], keys: readonly string[], cfg: BootstrapConfig): PairedResult {
  if (a.length !== b.length || a.length !== keys.length) throw new RangeError("a, b and keys must have the same length");
  const diffs = a.map((x, i) => x - (b[i] as number));
  const { mean, ci95 } = clusterMeanCi(diffs, keys, cfg);
  let onlyA = 0;
  let onlyB = 0;
  a.forEach((x, i) => {
    const y = b[i] as number;
    if (x === 1 && y === 0) onlyA++;
    else if (x === 0 && y === 1) onlyB++;
  });
  return { n: a.length, mean_delta: mean, ci95, p_value: mcnemarExact(onlyA, onlyB), only_a: onlyA, only_b: onlyB };
}

/** Cohen's kappa of two binary raters (null when expected agreement is 1). */
export function cohenKappa(a: readonly boolean[], b: readonly boolean[]): number | null {
  const n = a.length;
  if (n === 0 || n !== b.length) return null;
  const agree = a.filter((x, i) => x === b[i]).length / n;
  const pa = a.filter(Boolean).length / n;
  const pb = b.filter(Boolean).length / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  return pe >= 1 ? null : (agree - pe) / (1 - pe);
}
