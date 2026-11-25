/**
 * Pure metric arithmetic of the evaluate stage. No I/O, no randomness.
 *
 * Unit = one dataset row (one DOM element), weight `w` = characters of its own text (or 1 when the
 * weight is unavailable), positive class = keep (y = 1). Counts are weighted sums, so `tp+fp+tn+fn`
 * is the total weight (the contract's `n`; with character weights these are characters).
 */

export interface Counts {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

export const METRICS = ["precision", "recall", "f1", "accuracy"] as const;
export type Metric = (typeof METRICS)[number];

export const emptyCounts = (): Counts => ({ tp: 0, fp: 0, tn: 0, fn: 0 });

export const totalOf = (c: Counts): number => c.tp + c.fp + c.tn + c.fn;

/** `P = TP/(TP+FP)`, `R = TP/(TP+FN)`, `F1 = 2PR/(P+R)`; an empty denominator gives 0 (never 1). */
export function metricOf(c: Counts, m: Metric): number {
  switch (m) {
    case "precision":
      return c.tp + c.fp > 0 ? c.tp / (c.tp + c.fp) : 0;
    case "recall":
      return c.tp + c.fn > 0 ? c.tp / (c.tp + c.fn) : 0;
    case "f1": {
      const p = metricOf(c, "precision");
      const r = metricOf(c, "recall");
      return p + r > 0 ? (2 * p * r) / (p + r) : 0;
    }
    case "accuracy": {
      const n = totalOf(c);
      return n > 0 ? (c.tp + c.tn) / n : 0;
    }
  }
}

/** The contract's `Prf` object (counts are integer characters by construction, or elements with weight 1). */
export function prfOf(c: Counts): {
  n: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
} {
  return {
    n: totalOf(c),
    tp: c.tp,
    fp: c.fp,
    tn: c.tn,
    fn: c.fn,
    precision: metricOf(c, "precision"),
    recall: metricOf(c, "recall"),
    f1: metricOf(c, "f1"),
    accuracy: metricOf(c, "accuracy"),
  };
}

export function addCount(c: Counts, y: number, predicted: boolean, w: number): void {
  if (y === 1) {
    if (predicted) c.tp += w;
    else c.fn += w;
  } else if (predicted) c.fp += w;
  else c.tn += w;
}

/** A scored sample: model score in [0, 1], gold label 0/1, weight >= 0. */
export interface Scored {
  score: number;
  y: number;
  w: number;
}

const EPS = 1e-15;

/** Weighted ROC AUC (Mann-Whitney, ties count half). 0.5 when only one class has weight. */
export function aucRoc(s: readonly Scored[]): number {
  const sorted = [...s].sort((a, b) => a.score - b.score);
  let posW = 0;
  let negW = 0;
  for (const r of sorted) {
    if (r.y === 1) posW += r.w;
    else negW += r.w;
  }
  if (posW === 0 || negW === 0) return 0.5;
  let negBelow = 0;
  let acc = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    let tiePos = 0;
    let tieNeg = 0;
    while (j < sorted.length && (sorted[j] as Scored).score === (sorted[i] as Scored).score) {
      const r = sorted[j] as Scored;
      if (r.y === 1) tiePos += r.w;
      else tieNeg += r.w;
      j++;
    }
    acc += tiePos * (negBelow + tieNeg / 2);
    negBelow += tieNeg;
    i = j;
  }
  return acc / (posW * negW);
}

/** Average precision (step interpolation over distinct scores, weighted). 0 when there is no positive weight. */
export function prAuc(s: readonly Scored[]): number {
  const sorted = [...s].sort((a, b) => b.score - a.score);
  const posW = sorted.reduce((a, r) => a + (r.y === 1 ? r.w : 0), 0);
  if (posW === 0) return 0;
  let tp = 0;
  let fp = 0;
  let prevRecall = 0;
  let ap = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && (sorted[j] as Scored).score === (sorted[i] as Scored).score) {
      const r = sorted[j] as Scored;
      if (r.y === 1) tp += r.w;
      else fp += r.w;
      j++;
    }
    const recall = tp / posW;
    if (tp + fp > 0) ap += (recall - prevRecall) * (tp / (tp + fp));
    prevRecall = recall;
    i = j;
  }
  return Math.min(1, ap);
}

/** Weighted mean negative log-likelihood, probabilities clipped to [1e-15, 1 - 1e-15]. */
export function logloss(s: readonly Scored[]): number {
  let sum = 0;
  let w = 0;
  for (const r of s) {
    const p = Math.min(1 - EPS, Math.max(EPS, r.score));
    sum += r.w * -(r.y === 1 ? Math.log(p) : Math.log(1 - p));
    w += r.w;
  }
  return w > 0 ? sum / w : 0;
}

export function brier(s: readonly Scored[]): number {
  let sum = 0;
  let w = 0;
  for (const r of s) {
    sum += r.w * (r.score - r.y) ** 2;
    w += r.w;
  }
  return w > 0 ? sum / w : 0;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  mean_p: number;
  frac_pos: number;
}

/** Equal-width reliability bins `[lo, hi)` (the last one is closed); `n` is the bin's weight. ECE is the weight-averaged |frac_pos - mean_p|. */
export function calibration(s: readonly Scored[], bins = 10): { ece: number; bins: CalibrationBin[] } {
  const acc = Array.from({ length: bins }, () => ({ w: 0, p: 0, pos: 0 }));
  for (const r of s) {
    const b = acc[Math.min(bins - 1, Math.floor(r.score * bins))] as { w: number; p: number; pos: number };
    b.w += r.w;
    b.p += r.w * r.score;
    b.pos += r.w * r.y;
  }
  const total = acc.reduce((a, b) => a + b.w, 0);
  let ece = 0;
  const out = acc.map((b, i): CalibrationBin => {
    const meanP = b.w > 0 ? b.p / b.w : 0;
    const frac = b.w > 0 ? b.pos / b.w : 0;
    if (total > 0) ece += (b.w / total) * Math.abs(frac - meanP);
    return { lo: i / bins, hi: (i + 1) / bins, n: b.w, mean_p: meanP, frac_pos: frac };
  });
  return { ece: Math.min(1, ece), bins: out };
}

export interface PrPoint {
  threshold: number;
  precision: number;
  recall: number;
}

/**
 * Precision/recall at each threshold (predicted keep = score >= threshold). Thresholds that keep
 * nothing are dropped (precision is undefined there). Sorted by threshold ascending.
 */
export function prPoints(s: readonly Scored[], thresholds: readonly number[]): PrPoint[] {
  const posW = s.reduce((a, r) => a + (r.y === 1 ? r.w : 0), 0);
  const out: PrPoint[] = [];
  for (const t of [...thresholds].sort((a, b) => a - b)) {
    let tp = 0;
    let kept = 0;
    for (const r of s) {
      if (r.score >= t) {
        kept += r.w;
        if (r.y === 1) tp += r.w;
      }
    }
    if (kept > 0) out.push({ threshold: t, precision: tp / kept, recall: posW > 0 ? tp / posW : 0 });
  }
  return out;
}
