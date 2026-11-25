// Element-level evaluation of "kept by extractor" against the hand-written truth.
// Unit of evaluation: elements that own non-whitespace text (text units are attributed to their
// parent element). Counts are kept raw so they can be summed per category before ratios are taken.

/** Elements the truth must cover: own text, excluding <title> (document metadata, not page content). */
export const isEvaluable = (e) => e.ownText.length > 0 && e.tag !== 'title';

const POSITIVES = {
  main: (l) => l === 'main',
  ms: (l) => l === 'main' || l === 'support', // main + support
};

/**
 * @param snapshot  collect snapshot
 * @param truth     {id: {label, rule}} from window.__gp.applyTruth
 * @param kept      Set of element ids the extractor kept
 */
export function pageCounts(snapshot, truth, kept) {
  const out = { elems: 0, uncovered: 0, survival: { main: { n: 0, c: 0, kn: 0, kc: 0 } } };
  for (const key of Object.keys(POSITIVES)) for (const scope of ['all', 'vis']) out[`${key}.${scope}`] = { tp: { n: 0, c: 0 }, fp: { n: 0, c: 0 }, fn: { n: 0, c: 0 } };
  for (const e of snapshot.elements) {
    const w = e.ownText.length;
    if (!isEvaluable(e)) continue;
    const label = truth[e.id] && truth[e.id].label;
    if (!label) { out.uncovered++; continue; }
    out.elems++;
    const k = kept.has(e.id);
    if (label === 'main') {
      out.survival.main.n++; out.survival.main.c += w;
      if (k) { out.survival.main.kn++; out.survival.main.kc += w; }
    }
    for (const [key, isPos] of Object.entries(POSITIVES)) {
      const pos = isPos(label);
      const cell = pos ? (k ? 'tp' : 'fn') : (k ? 'fp' : null);
      if (!cell) continue;
      for (const scope of ['all', 'vis']) {
        if (scope === 'vis' && !e.visible) continue;
        const c = out[`${key}.${scope}`][cell];
        c.n++; c.c += w;
      }
    }
  }
  return out;
}

export function sumCounts(list) {
  const out = list[0] ? JSON.parse(JSON.stringify(list[0])) : null;
  if (!out) return null;
  const add = (a, b) => { for (const k of Object.keys(b)) { if (typeof b[k] === 'number') a[k] += b[k]; else add(a[k], b[k]); } };
  for (const c of list.slice(1)) add(out, c);
  return out;
}

const ratio = (a, b) => (b ? a / b : NaN);
/** precision / recall / f1 from a tp/fp/fn triple, element-weighted ('n') or char-weighted ('c'). */
export function prf(cell, w = 'n') {
  const tp = cell.tp[w], fp = cell.fp[w], fn = cell.fn[w];
  const p = ratio(tp, tp + fp), r = ratio(tp, tp + fn);
  return { p, r, f1: ratio(2 * p * r, p + r) };
}

export const pct = (x) => (Number.isFinite(x) ? (100 * x).toFixed(1) : 'n/a');
