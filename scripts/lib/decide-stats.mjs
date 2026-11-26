// Small deterministic statistics for scripts/decide-dom-v0.mjs: a cluster bootstrap of a mean on the pre-registered
// generator (numpy.random.default_rng, reproduced bit for bit by @gran-prix/stats) and numpy's linear-interpolation
// percentile. The algorithm (order of the domains, the generator calls, the percentile) is the canonical one specified
// in packages/stats/README.md and mirrored by tools/baselines/stats/bootstrap_ref.py.
import { clusterMeanDraws, quantileLinear, round12 } from "@gran-prix/stats";

export const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Cluster bootstrap of the mean of `values`: `clusters[i]` is the domain of value i; domains are redrawn whole (with
 * replacement, one `rng.integers(0, n_domains, size=n_domains)` call per replicate on `default_rng(seed)`, the domains
 * ordered by key) and the statistic of a resample is the mean over all the values drawn (every page weighs 1, like the
 * macro-per-page of the protocol). Returns the q-quantile (numpy, method "linear"; q rounded to 12 decimals, so that
 * 1 - 0.95 is the 0.05 of np.quantile(x, 0.05)) of the resampled means.
 */
export function clusterBootstrapQuantile(values, clusters, { resamples, seed, q }) {
  if (values.length !== clusters.length) throw new RangeError("values and clusters must have the same length");
  if (values.length === 0) throw new RangeError("nothing to resample");
  const draws = clusterMeanDraws({ values, keys: clusters.map(String), resamples, seed, stratified: false });
  const sorted = Array.from(draws).sort((a, b) => a - b);
  return quantileLinear(sorted, round12(q));
}
