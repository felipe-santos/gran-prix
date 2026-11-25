import { groupedFolds, splitFold } from "./folds.js";
import type { GridPoint } from "./grid.js";
import { RECALL_TARGET, bestConfig, macroPageF1, tauStar } from "./tau.js";

/**
 * Grouped cross-validation with NESTED tuning over a fixed grid: the procedure of `gbdt.py` (`run`), generic over the
 * model. A `Fitter` trains the configuration `point` on the rows `fit` and returns P(keep) for the rows `predict`; the
 * stage plugs gp-train in, the tests plug a toy model in.
 *
 *  1. model selection on ALL of dev: for each configuration, a grouped k-fold OOF; criterion = macro-page F1 at the
 *     configuration's own tau* (character-weighted recall >= 0.95 on that OOF);
 *  2. the dev OOF that is REPORTED is nested: for every outer fold, the same selection is repeated by an inner grouped
 *     CV on the other folds only, and the winner is refit on them to score the held-out fold. So a dev page's score
 *     never depends on its own labels or on a choice made with them;
 *  3. tau* is computed on that nested OOF.
 * The folds are by domain (`key`): a domain never straddles two folds, at either level.
 */

export interface DevRows {
  /** Page (group id) of every row. */
  g: readonly string[];
  /** Domain (group key) of every row: what the folds must not cut. */
  key: readonly string[];
  y: ArrayLike<number>;
  /** Character weight of every row (1 when the dataset has none). */
  w: ArrayLike<number>;
}

/** Why a fit is being run: model selection on all of dev, the inner tuning inside outer fold `outer`, or the refit that scores that fold. */
export type FitTag = { phase: "select" } | { phase: "inner" | "outer"; outer: number };

export type Fitter = (point: GridPoint, fit: readonly number[], predict: readonly number[], tag: FitTag) => Promise<ArrayLike<number>>;

export interface CvOptions {
  /** Outer folds (manifest `split.kfold.k`, default 5). */
  folds: number;
  /** Folds of the inner tuning inside each outer fold. */
  innerFolds: number;
  /** Fits running at once (never changes a result). */
  jobs: number;
  recallTarget?: number;
}

export interface CvResult {
  /** Per configuration: macro-page F1 at the configuration's own tau* on the all-dev OOF (the selection criterion). */
  scores: number[];
  /** Per configuration: tau* of that OOF. */
  taus: number[];
  selected: number;
  /** Nested dev OOF, one P(keep) per dev row. */
  oof: Float64Array;
  /** Configuration picked by the inner tuning of each outer fold. */
  outerPicks: number[];
  /** Inner scores of each outer fold (rows: outer fold; columns: configuration). */
  innerScores: number[][];
  tau: number;
  /** Macro-page F1 of the nested OOF at `tau`. */
  macroPageF1: number;
  fits: number;
}

/** At most `limit` async tasks run at once; first in, first out. */
export class Limiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`jobs must be an integer >= 1 (got ${limit})`);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    // A finishing task hands its slot straight to the next waiter, so the count never overshoots.
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve));
    else this.active++;
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}

const pick = <T>(a: ArrayLike<T>, idx: readonly number[]): T[] => idx.map((i) => a[i] as T);

/** Per configuration, over the rows `idx`: OOF of a grouped CV, its tau* and the macro-page F1 at it. */
async function cvScores(
  dev: DevRows,
  idx: readonly number[],
  k: number,
  grid: readonly GridPoint[],
  fit: Fitter,
  tag: FitTag,
  target: number,
): Promise<{ scores: number[]; taus: number[]; oofs: Float64Array[] }> {
  const keys = pick(dev.key, idx);
  const y = pick(dev.y, idx);
  const w = pick(dev.w, idx);
  const pages = pick(dev.g, idx);
  const folds = groupedFolds(keys, k);
  const oofs = grid.map(() => new Float64Array(idx.length));
  const jobs: Array<Promise<void>> = [];
  grid.forEach((point, c) => {
    for (let f = 0; f < k; f++) {
      const { fit: fitLocal, held } = splitFold(folds, f);
      if (held.length === 0 || fitLocal.length === 0) continue;
      jobs.push(
        fit(point, fitLocal.map((i) => idx[i] as number), held.map((i) => idx[i] as number), tag).then((p) => {
          held.forEach((local, j) => ((oofs[c] as Float64Array)[local] = p[j] as number));
        }),
      );
    }
  });
  await Promise.all(jobs);
  const taus = oofs.map((o) => tauStar(o, y, w, target));
  const scores = oofs.map((o, c) => macroPageF1(o, y, w, pages, taus[c] as number));
  return { scores, taus, oofs };
}

export async function runCv(dev: DevRows, grid: readonly GridPoint[], fitter: Fitter, opts: CvOptions): Promise<CvResult> {
  const n = dev.y.length;
  const target = opts.recallTarget ?? RECALL_TARGET;
  const limiter = new Limiter(opts.jobs);
  let fits = 0;
  const fit: Fitter = (point, f, p, tag) =>
    limiter.run(async () => {
      fits++;
      return fitter(point, f, p, tag);
    });
  const all = Array.from({ length: n }, (_, i) => i);

  // 1) model selection on all of dev
  const sel = await cvScores(dev, all, opts.folds, grid, fit, { phase: "select" }, target);
  const selected = bestConfig(sel.scores);

  // 2) nested dev OOF
  const outer = groupedFolds(dev.key, opts.folds);
  const oof = new Float64Array(n);
  const outerPicks = new Array<number>(opts.folds).fill(-1);
  const innerScores = new Array<number[]>(opts.folds).fill([]);
  await Promise.all(
    Array.from({ length: opts.folds }, async (_, f) => {
      const { fit: train, held } = splitFold(outer, f);
      if (held.length === 0 || train.length === 0) return;
      const inner = await cvScores(dev, train, opts.innerFolds, grid, fit, { phase: "inner", outer: f }, target);
      const c = bestConfig(inner.scores);
      outerPicks[f] = c;
      innerScores[f] = inner.scores;
      const p = await fit(grid[c] as GridPoint, train, held, { phase: "outer", outer: f });
      held.forEach((row, j) => (oof[row] = p[j] as number));
    }),
  );
  if (outerPicks.some((c) => c < 0)) throw new Error("an outer fold is empty: fewer domains than folds");

  // 3) tau* on the nested OOF
  const tau = tauStar(oof, dev.y, dev.w, target);
  return {
    scores: sel.scores,
    taus: sel.taus,
    selected,
    oof,
    outerPicks,
    innerScores,
    tau,
    macroPageF1: macroPageF1(oof, dev.y, dev.w, dev.g, tau),
    fits,
  };
}
