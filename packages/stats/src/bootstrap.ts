/**
 * The canonical cluster bootstrap of protocol experimento-dom-v0, section 6.5: stratified by category,
 * resampling whole clusters (registrable domains), percentile interval, `numpy.random.default_rng(seed)`.
 * The same algorithm is written in Python in tools/baselines/stats/bootstrap_ref.py; the two must agree
 * to the last bit (test/bootstrap-parity.test.ts). README.md of this package is the specification.
 *
 *  1. Units are ordered canonically: stratified, by (stratum, key); otherwise by (key, stratum). Strings
 *     compare by Unicode code point (JS's default sort compares UTF-16 units, which differs for
 *     astral characters). A repeated (stratum, key) is an error.
 *  2. The pools are the strata in that order (one pool with every unit when not stratified).
 *  3. Replicate b = 0..B-1 consumes the generator in this order: for each pool, ONE call
 *     `rng.integers(0, n_pool, size=n_pool)`; the i-th value picks the unit at that position of the pool.
 *     counts[unit] is the number of times the unit was picked.
 *  4. The statistic of a replicate is a function of the counts. Replicates with a non-finite statistic
 *     are dropped; the interval is null if fewer than half survive.
 *  5. The interval is `numpy.quantile(finite, [lo, hi], method="linear")` with lo = round12((1-level)/2),
 *     hi = round12(1-lo) (round12 = 12 decimals), i.e. the 2.5% and 97.5% percentiles for level 0.95.
 */
import { Generator } from "./generator.js";

/** What identifies and groups a resampling unit. */
export interface BootstrapUnit {
  stratum: string;
  key: string;
}

/** Compare strings by Unicode code point (the order of Python's `sorted` on `str`). */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const d = (x.value.codePointAt(0) as number) - (y.value.codePointAt(0) as number);
    if (d !== 0) return d;
  }
}

/** The pools of step 2, as indices into `units`, each in the canonical order of step 1. */
export function bootstrapPools(units: readonly BootstrapUnit[], stratified: boolean): number[][] {
  const order = units.map((_, i) => i);
  const u = (i: number): BootstrapUnit => units[i] as BootstrapUnit;
  order.sort((i, j) =>
    stratified
      ? compareCodePoints(u(i).stratum, u(j).stratum) || compareCodePoints(u(i).key, u(j).key)
      : compareCodePoints(u(i).key, u(j).key) || compareCodePoints(u(i).stratum, u(j).stratum),
  );
  for (let k = 1; k < order.length; k++) {
    const a = u(order[k - 1] as number);
    const b = u(order[k] as number);
    if (a.stratum === b.stratum && a.key === b.key) throw new Error(`duplicate bootstrap unit (stratum "${a.stratum}", key "${a.key}")`);
  }
  if (!stratified) return order.length > 0 ? [order] : [];
  const pools: number[][] = [];
  let last: string | undefined;
  for (const i of order) {
    if (last === undefined || u(i).stratum !== last) {
      pools.push([]);
      last = u(i).stratum;
    }
    (pools[pools.length - 1] as number[]).push(i);
  }
  return pools;
}

/** One replicate (step 3): fills `counts` (indexed like `units`) with how many times each unit was drawn. */
export function drawCounts(pools: readonly (readonly number[])[], rng: Generator, counts: Float64Array, scratch: readonly Float64Array[]): void {
  counts.fill(0);
  for (let p = 0; p < pools.length; p++) {
    const pool = pools[p] as readonly number[];
    const draws = scratch[p] as Float64Array;
    rng.fill(draws, 0, pool.length);
    for (let i = 0; i < draws.length; i++) {
      const unit = pool[draws[i] as number] as number;
      counts[unit] = (counts[unit] as number) + 1;
    }
  }
}

/**
 * `numpy.quantile(sorted, q, method="linear")` for ascending `sorted` and 0 <= q <= 1, including numpy's
 * interpolation formula (`b - (b - a) * (1 - t)` for t >= 0.5), so results match to the last bit.
 */
export function quantileLinear(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const virtual = (n - 1) * q;
  if (virtual <= 0) return sorted[0] as number;
  if (virtual >= n - 1) return sorted[n - 1] as number;
  const prev = Math.floor(virtual);
  const t = virtual - prev;
  const a = sorted[prev] as number;
  const b = sorted[prev + 1] as number;
  const diff = b - a;
  return t >= 0.5 ? b - diff * (1 - t) : a + diff * t;
}

export const round12 = (x: number): number => Number(x.toFixed(12));

/** The two quantiles of a central interval of `level` (step 5). */
export function ciQuantiles(level: number): [number, number] {
  const lo = round12((1 - level) / 2);
  return [lo, round12(1 - lo)];
}

export type Ci = [number, number];

/** Percentile interval over the finite values; `null` when fewer than half of `total` are finite. */
export function percentileCi(values: readonly number[], total: number, level = 0.95): Ci | null {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0 || finite.length < total / 2) return null;
  const [lo, hi] = ciQuantiles(level);
  return [quantileLinear(finite, lo), quantileLinear(finite, hi)];
}

/**
 * Runs `resamples` replicates over `units` and returns the statistic of each replicate, per estimator key
 * (every estimator sees the same counts, so differences between systems are paired).
 */
export function bootstrapDraws(opts: {
  units: readonly BootstrapUnit[];
  estimators: ReadonlyMap<string, (counts: Float64Array) => number>;
  resamples: number;
  seed: number | bigint;
  stratified: boolean;
}): Map<string, number[]> {
  const pools = bootstrapPools(opts.units, opts.stratified);
  const rng = Generator.defaultRng(opts.seed);
  const keys = [...opts.estimators.keys()];
  const fns = keys.map((k) => opts.estimators.get(k) as (counts: Float64Array) => number);
  const draws = keys.map(() => new Array<number>(opts.resamples));
  const counts = new Float64Array(opts.units.length);
  const scratch = pools.map((p) => new Float64Array(p.length));
  for (let b = 0; b < opts.resamples; b++) {
    drawCounts(pools, rng, counts, scratch);
    for (let k = 0; k < fns.length; k++) (draws[k] as number[])[b] = (fns[k] as (c: Float64Array) => number)(counts);
  }
  return new Map(keys.map((k, i) => [k, draws[i] as number[]]));
}

/**
 * Replicate means of `values` under the cluster bootstrap (the statistic of scripts/decide-dom-v0.mjs:
 * every value weighs 1, so a cluster weighs by its size). Mirrors `cluster_mean_draws` of bootstrap_ref.py:
 * units are the distinct (stratum, key); a unit's sum runs over its values in input order and a replicate's
 * mean accumulates over the units in canonical order, left to right, so the doubles match the reference.
 */
export function clusterMeanDraws(opts: {
  values: readonly number[];
  keys: readonly string[];
  strata?: readonly string[];
  resamples: number;
  seed: number | bigint;
  stratified: boolean;
}): Float64Array {
  const { values, keys } = opts;
  if (values.length !== keys.length || (opts.strata !== undefined && opts.strata.length !== values.length)) {
    throw new RangeError("values, keys and strata must have the same length");
  }
  const index = new Map<string, number>();
  const units: BootstrapUnit[] = [];
  const sums: number[] = [];
  const sizes: number[] = [];
  values.forEach((v, i) => {
    const stratum = opts.strata?.[i] ?? "";
    const id = `${stratum.length}:${stratum}${keys[i] as string}`; // unambiguous (stratum, key) identity
    let u = index.get(id);
    if (u === undefined) {
      u = units.length;
      index.set(id, u);
      units.push({ stratum, key: keys[i] as string });
      sums.push(0);
      sizes.push(0);
    }
    sums[u] = (sums[u] as number) + v;
    sizes[u] = (sizes[u] as number) + 1;
  });
  const pools = bootstrapPools(units, opts.stratified);
  const flat = pools.flat();
  const rng = Generator.defaultRng(opts.seed);
  const scratch = pools.map((p) => new Float64Array(p.length));
  const counts = new Float64Array(units.length);
  const out = new Float64Array(opts.resamples);
  for (let b = 0; b < opts.resamples; b++) {
    drawCounts(pools, rng, counts, scratch);
    let s = 0;
    let k = 0;
    for (const i of flat) {
      const c = counts[i] as number;
      s += c * (sums[i] as number);
      k += c * (sizes[i] as number);
    }
    out[b] = k > 0 ? s / k : NaN;
  }
  return out;
}
