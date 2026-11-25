/**
 * The operating point and the selection criterion of the DOM experiment (protocol 6.3 and 7), as pure functions.
 * They mirror `tau_star`, `macro_page_f1` and `best_config` of `tools/baselines/gbdt/gbdt.py` so that the MLP and the
 * GBDT are tuned and scored by the same rule (`test/train-cv-tau.test.ts` cross-checks them against the Python).
 */

/** Recall that the operating point must keep (protocol 6.3). */
export const RECALL_TARGET = 0.95;

/** Tolerance of the recall comparison; the same epsilon as the Python (`cum >= target * total - 1e-12`). */
const EPS = 1e-12;

/**
 * tau*: the largest threshold whose character-weighted recall of `p >= tau` is at least `target`.
 *
 * Only a score that ends a run of equal scores is a valid cut (`p >= tau` is a step function), so the answer is always
 * one of the scores. Positive = `y === 1`, weight = `w`. With no positive weight there is nothing to protect and the
 * answer is 0.5 (the Python's convention). `target` above the reachable recall cannot happen for target <= 1: the
 * lowest score keeps everything.
 */
export function tauStar(p: ArrayLike<number>, y: ArrayLike<number>, w: ArrayLike<number>, target: number = RECALL_TARGET): number {
  const n = p.length;
  let total = 0;
  for (let i = 0; i < n; i++) if (y[i] === 1) total += w[i] as number;
  if (!(total > 0)) return 0.5;
  // Stable sort by descending score, like numpy's `argsort(-p, kind="stable")`.
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => (p[b] as number) - (p[a] as number) || a - b);
  let cum = 0;
  for (let k = 0; k < n; k++) {
    const i = order[k] as number;
    if (y[i] === 1) cum += w[i] as number;
    const endsRun = k === n - 1 || (p[order[k + 1] as number] as number) !== (p[i] as number);
    if (endsRun && cum >= target * total - EPS) return p[i] as number;
  }
  return p[order[n - 1] as number] as number;
}

/** Character-weighted recall of `p >= tau`. 0 when there is no positive weight. */
export function weightedRecall(p: ArrayLike<number>, y: ArrayLike<number>, w: ArrayLike<number>, tau: number): number {
  let tp = 0;
  let pos = 0;
  for (let i = 0; i < p.length; i++) {
    if (y[i] !== 1) continue;
    pos += w[i] as number;
    if ((p[i] as number) >= tau) tp += w[i] as number;
  }
  return pos > 0 ? tp / pos : 0;
}

/**
 * Mean over pages of the character-weighted F1 of `p >= tau` (protocol 6.2: an empty output is F1 = 0, never 1;
 * a page with no weight at all counts as 0, like the Python). `pages[i]` identifies the page of row i.
 */
export function macroPageF1(p: ArrayLike<number>, y: ArrayLike<number>, w: ArrayLike<number>, pages: ArrayLike<string>, tau: number): number {
  const n = p.length;
  if (n === 0) return 0;
  const index = new Map<string, number>();
  const tp: number[] = [];
  const fp: number[] = [];
  const fn: number[] = [];
  for (let i = 0; i < n; i++) {
    const key = pages[i] as string;
    let g = index.get(key);
    if (g === undefined) {
      g = tp.length;
      index.set(key, g);
      tp.push(0);
      fp.push(0);
      fn.push(0);
    }
    const keep = (p[i] as number) >= tau;
    const wi = w[i] as number;
    if (keep && y[i] === 1) tp[g] = (tp[g] as number) + wi;
    else if (keep) fp[g] = (fp[g] as number) + wi;
    else if (y[i] === 1) fn[g] = (fn[g] as number) + wi;
  }
  let sum = 0;
  for (let g = 0; g < tp.length; g++) {
    const den = 2 * (tp[g] as number) + (fp[g] as number) + (fn[g] as number);
    sum += den > 0 ? (2 * (tp[g] as number)) / den : 0;
  }
  return sum / tp.length;
}

/** Index of the best score; ties (after rounding to 12 places) go to the earlier, simpler configuration. */
export function bestConfig(scores: readonly number[]): number {
  if (scores.length === 0) throw new Error("no configuration to choose from");
  const r = (v: number): number => Math.round(v * 1e12) / 1e12;
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (r(scores[i] as number) > r(scores[best] as number)) best = i;
  return best;
}
