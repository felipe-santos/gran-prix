/**
 * Grouped folds, identical to `grouped_folds` of `tools/baselines/gbdt/gbdt.py`: every key (a registrable domain)
 * lives in ONE fold. Deterministic and balanced, no randomness and no seed: the keys sorted by (-rows, key) go one by
 * one to the currently lightest fold (ties: the lowest fold id).
 */
export function groupedFolds(keys: readonly string[], k: number): Int32Array {
  if (!Number.isInteger(k) || k < 2) throw new RangeError(`the number of folds must be an integer >= 2 (got ${k})`);
  const count = new Map<string, number>();
  for (const key of keys) count.set(key, (count.get(key) ?? 0) + 1);
  const unique = [...count.keys()];
  if (unique.length < k) throw new Error(`${unique.length} distinct group keys cannot fill ${k} folds`);
  const order = unique.sort((a, b) => (count.get(b) as number) - (count.get(a) as number) || codePointOrder(a, b));
  const load = new Array<number>(k).fill(0);
  const foldOf = new Map<string, number>();
  for (const key of order) {
    let f = 0;
    for (let j = 1; j < k; j++) if ((load[j] as number) < (load[f] as number)) f = j;
    foldOf.set(key, f);
    load[f] = (load[f] as number) + (count.get(key) as number);
  }
  return Int32Array.from(keys, (key) => foldOf.get(key) as number);
}

/** String order by Unicode code point, like Python's `sorted` on `str` (JS `<` compares UTF-16 units). */
export function codePointOrder(a: string, b: string): number {
  if (a === b) return 0;
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] as string).codePointAt(0)! - (y[i] as string).codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** Row indices of fold `f` (held out) and of the other folds (fit). */
export function splitFold(folds: Int32Array, f: number): { fit: number[]; held: number[] } {
  const fit: number[] = [];
  const held: number[] = [];
  folds.forEach((v, i) => (v === f ? held : fit).push(i));
  return { fit, held };
}
