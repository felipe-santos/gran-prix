// Small deterministic statistics for scripts/decide-dom-v0.mjs: a seeded PRNG, a linear-interpolation percentile
// (numpy's default) and a cluster bootstrap of a mean. No dependencies.

export const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** mulberry32: 32-bit state, deterministic, well mixed for this use. NOT numpy's default_rng (the protocol's reference): the resampling streams differ, the method is the same. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** q-quantile (0..1) of an ASCENDING sorted array, linear interpolation between order statistics. */
export function percentile(sorted, q) {
  if (sorted.length === 0) throw new RangeError("percentile of an empty sample");
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Cluster bootstrap of the mean of `values`: `clusters[i]` is the domain of value i; domains are redrawn whole (with
 * replacement) and the statistic of a resample is the mean over all the values drawn (every page weighs 1, like the
 * macro-per-page of the protocol). Returns the q-quantile of the resampled means.
 */
export function clusterBootstrapQuantile(values, clusters, { resamples, seed, q }) {
  if (values.length !== clusters.length) throw new RangeError("values and clusters must have the same length");
  if (values.length === 0) throw new RangeError("nothing to resample");
  const index = new Map();
  const sums = [];
  const counts = [];
  values.forEach((v, i) => {
    let c = index.get(clusters[i]);
    if (c === undefined) {
      c = sums.length;
      index.set(clusters[i], c);
      sums.push(0);
      counts.push(0);
    }
    sums[c] += v;
    counts[c] += 1;
  });
  const rng = mulberry32(seed);
  const n = sums.length;
  const stats = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const c = Math.floor(rng() * n);
      s += sums[c];
      k += counts[c];
    }
    stats[b] = s / k;
  }
  stats.sort();
  return percentile(Array.from(stats), q);
}
