/**
 * Token-reduction statistics (protocol 10): per page `r_p = tok(D) / tok(output)`; report the MEDIAN and the IQR
 * (never the mean), per category and overall, with the pooled ratio (sum over sum) as the secondary view.
 *
 * Empty output (`tok(output) = 0`): the ratio is infinite, and an infinite ratio would reward a system that returns
 * nothing (protocol 6.2: an empty output is P = 0, F1 = 0, never 1.0). So an empty page earns NO credit: it counts
 * with reduction 0 (r_p = 0, "no x fewer tokens") and fraction kept 1, it is counted in `n_empty`, and it stays in
 * the median, so a system that is empty on more than half of the pages cannot have a median above 0. In the pooled
 * (sum over sum) view, which cannot hold a 0, an empty page enters at its full size. A page whose full text is
 * empty too (`tok(D) = 0`, e.g. a D2 of a page with nothing rendered) has no ratio and is left out (`n_undefined`).
 *
 * Quantiles: linear interpolation between order statistics (the numpy default, "type 7").
 */

export interface PageTokenPair {
  /** Tokens of the denominator document (D1 or D2). */
  full: number;
  /** Tokens of the system's output (0 = empty output). */
  out: number;
}

export interface RatioStats {
  /** Pages in the median (those with `full > 0`). */
  n_pages: number;
  /** Of them, pages with an empty output (no credit). */
  n_empty: number;
  /** Pages left out because `full = 0`. */
  n_undefined: number;
  full_tokens: number;
  kept_tokens: number;
  /** Median over pages of kept/full (fraction kept; an empty page counts 1). */
  median_ratio: number | null;
  iqr_ratio: [number, number] | null;
  /** Median over pages of full/kept (the "x fewer tokens" of G4; an empty page counts 0). */
  median_reduction: number | null;
  iqr_reduction: [number, number] | null;
  /** sum(kept) / sum(full), secondary, dominated by large pages; an empty page enters at its full size (no credit). */
  pooled_ratio: number | null;
  /** sum(full) / sum(kept) under the same convention; null when there are no pages. */
  pooled_reduction: number | null;
}

/** Quantile `q` in [0, 1] of `values` (any order), linear interpolation; null for an empty input. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = s[lo] as number;
  const b = s[hi] as number;
  return a + (b - a) * (pos - lo);
}

export const median = (values: readonly number[]): number | null => quantile(values, 0.5);

export function iqr(values: readonly number[]): [number, number] | null {
  const lo = quantile(values, 0.25);
  const hi = quantile(values, 0.75);
  return lo === null || hi === null ? null : [lo, hi];
}

export function summarizeRatios(pages: readonly PageTokenPair[]): RatioStats {
  const usable = pages.filter((p) => p.full > 0);
  const fractions = usable.map((p) => (p.out === 0 ? 1 : p.out / p.full));
  const reductions = usable.map((p) => (p.out === 0 ? 0 : p.full / p.out));
  const full = usable.reduce((s, p) => s + p.full, 0);
  const kept = usable.reduce((s, p) => s + p.out, 0);
  // The pooled sums cannot hold a ratio of 0, so an empty page enters them at its full size (fraction 1, no credit).
  const keptNoCredit = usable.reduce((s, p) => s + (p.out === 0 ? p.full : p.out), 0);
  return {
    n_pages: usable.length,
    n_empty: usable.filter((p) => p.out === 0).length,
    n_undefined: pages.length - usable.length,
    full_tokens: full,
    kept_tokens: kept,
    median_ratio: median(fractions),
    iqr_ratio: iqr(fractions),
    median_reduction: median(reductions),
    iqr_reduction: iqr(reductions),
    pooled_ratio: full > 0 ? keptNoCredit / full : null,
    pooled_reduction: keptNoCredit > 0 ? full / keptNoCredit : null,
  };
}

export interface PageTokenRecord {
  /** Stratum (category) of the page. */
  stratum: string;
  full: number;
  out: number;
}

export interface DenominatorSummary extends RatioStats {
  by_stratum: Record<string, RatioStats>;
}

/** Overall and per-stratum summary of one denominator (D1 or D2) for one system. Strata are sorted by name. */
export function summarizeByStratum(pages: readonly PageTokenRecord[]): DenominatorSummary {
  const strata = [...new Set(pages.map((p) => p.stratum))].sort();
  return {
    ...summarizeRatios(pages),
    by_stratum: Object.fromEntries(strata.map((s) => [s, summarizeRatios(pages.filter((p) => p.stratum === s))])),
  };
}
