import { bootstrapPools, drawCounts, Generator, percentileCi, quantileLinear, type BootstrapUnit, type Ci } from "@gran-prix/stats";

export { percentileCi, quantileLinear, type Ci };

/**
 * Seeded cluster bootstrap. The independent unit is the CLUSTER (a registrable domain, or a page),
 * never a row: every replicate redraws whole clusters with replacement, optionally within each
 * stratum so the stratum sizes stay fixed. A statistic is a function of the per-group
 * multiplicities of the replicate, so paired differences use the same resample for both systems.
 *
 * The generator is the pre-registered one (protocol 6.5): numpy.random.default_rng(seed), reproduced bit for bit by
 * @gran-prix/stats. The order of strata and clusters and the generator calls are the canonical algorithm specified in
 * that package's README and mirrored in Python by tools/baselines/stats/bootstrap_ref.py.
 */

/**
 * Deterministic 32-bit generator (sfc32), seeded through splitmix32. Returns floats in [0, 1).
 * For SYNTHETIC TEST DATA only (the fixtures of the evaluate and train.cv tests draw their pages with it): it is NOT the
 * bootstrap's generator and no inference may use it.
 */
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

/** A resampling unit: the groups (page indices) that must stay together, its key (the domain, or the page) and the stratum it is drawn within. */
export interface Cluster extends BootstrapUnit {
  groups: readonly number[];
}

/**
 * The replicates of the canonical bootstrap. `next()` is one replicate: how many times each group appears in the
 * resample (all the groups of a cluster share the count of the cluster).
 */
export class ClusterResampler {
  private readonly pools: number[][];
  private readonly rng: Generator;
  private readonly scratch: Float64Array[];
  private readonly counts: Float64Array;

  constructor(
    private readonly clusters: readonly Cluster[],
    private readonly nGroups: number,
    seed: number | bigint,
    stratified: boolean,
  ) {
    this.pools = bootstrapPools(clusters, stratified);
    this.rng = Generator.defaultRng(seed);
    this.scratch = this.pools.map((p) => new Float64Array(p.length));
    this.counts = new Float64Array(clusters.length);
  }

  next(): Float64Array {
    drawCounts(this.pools, this.rng, this.counts, this.scratch);
    const mult = new Float64Array(this.nGroups);
    this.clusters.forEach((c, i) => {
      const n = this.counts[i] as number;
      for (const g of c.groups) mult[g] = n;
    });
    return mult;
  }
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
  const resampler = new ClusterResampler(opts.clusters, opts.nGroups, opts.seed, opts.stratified);
  const keys = [...opts.estimators.keys()];
  const fns = keys.map((k) => opts.estimators.get(k) as Estimator);
  const draws = keys.map(() => new Array<number>(opts.resamples));
  for (let b = 0; b < opts.resamples; b++) {
    const mult = resampler.next();
    for (let k = 0; k < fns.length; k++) (draws[k] as number[])[b] = (fns[k] as Estimator)(mult);
  }
  return new Map(keys.map((k, i) => [k, percentileCi(draws[i] as number[], opts.resamples, opts.level)]));
}
