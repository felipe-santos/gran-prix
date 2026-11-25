/**
 * Seeded cluster bootstrap. The independent unit is the CLUSTER (a registrable domain, or a page),
 * never a row: every replicate redraws whole clusters with replacement, optionally within each
 * stratum so the stratum sizes stay fixed. A statistic is a function of the per-group
 * multiplicities of the replicate, so paired differences use the same resample for both systems.
 */

/** Deterministic 32-bit generator (sfc32), seeded through splitmix32. Returns floats in [0, 1). */
export function makeRng(seed: number): () => number {
  let s = (Math.trunc(seed) >>> 0) || 0x9e3779b9;
  const split = (): number => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
  let a = split();
  let b = split();
  let c = split();
  let d = split();
  const next = (): number => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}

/** A resampling unit: the groups (page indices) that must stay together, and the stratum it is drawn within. */
export interface Cluster {
  stratum: string;
  groups: readonly number[];
}

/** One replicate: how many times each group appears in the resample. */
export function drawMultiplicities(clusters: readonly Cluster[], nGroups: number, rng: () => number, stratified: boolean): Float64Array {
  const mult = new Float64Array(nGroups);
  const pools: Array<readonly Cluster[]> = stratified ? [...groupBy(clusters)] : [clusters];
  for (const pool of pools) {
    for (let i = 0; i < pool.length; i++) {
      const c = pool[Math.floor(rng() * pool.length)] as Cluster;
      for (const g of c.groups) mult[g] = (mult[g] as number) + 1;
    }
  }
  return mult;
}

function groupBy(clusters: readonly Cluster[]): Array<readonly Cluster[]> {
  const by = new Map<string, Cluster[]>();
  for (const c of clusters) {
    const list = by.get(c.stratum);
    if (list) list.push(c);
    else by.set(c.stratum, [c]);
  }
  return [...by.keys()].sort().map((k) => by.get(k) as Cluster[]);
}

/** Percentile of sorted values with linear interpolation (numpy's default method). */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

export type Ci = [number, number];

/** Percentile interval at `level` over the finite replicate values; `null` when fewer than half are finite. */
export function percentileCi(values: readonly number[], total: number, level = 0.95): Ci | null {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0 || finite.length < total / 2) return null;
  const alpha = (1 - level) / 2;
  return [quantileSorted(finite, alpha), quantileSorted(finite, 1 - alpha)];
}

export type Estimator = (mult: Float64Array) => number;

/**
 * Runs `resamples` replicates and returns, per estimator key, the percentile CI. The same
 * resample feeds every estimator (so differences between systems are paired).
 */
export function clusterBootstrap(opts: {
  clusters: readonly Cluster[];
  nGroups: number;
  estimators: ReadonlyMap<string, Estimator>;
  resamples: number;
  seed: number;
  stratified: boolean;
  level?: number;
}): Map<string, Ci | null> {
  const rng = makeRng(opts.seed);
  const keys = [...opts.estimators.keys()];
  const fns = keys.map((k) => opts.estimators.get(k) as Estimator);
  const draws = keys.map(() => new Array<number>(opts.resamples));
  for (let b = 0; b < opts.resamples; b++) {
    const mult = drawMultiplicities(opts.clusters, opts.nGroups, rng, opts.stratified);
    for (let k = 0; k < fns.length; k++) (draws[k] as number[])[b] = (fns[k] as Estimator)(mult);
  }
  return new Map(keys.map((k, i) => [k, percentileCi(draws[i] as number[], opts.resamples, opts.level)]));
}
