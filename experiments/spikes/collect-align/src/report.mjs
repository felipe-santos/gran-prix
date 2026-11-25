// Table printing + per-method counting for the fixture run.
import { pageCounts, sumCounts, prf, pct, isEvaluable } from './metrics.mjs';

const none = new Set();
/** The "kept element ids" each method yields for a record. */
export const METHODS = [
  ['rd-attr', 'Readability, data-gp-id survival (plain clone)', (r) => r.rd.plain.ids],
  ['rd-attr+shadow', 'Readability, data-gp-id survival (shadow flattened)', (r) => r.rd.flat.ids],
  ['rd-text', 'Readability text -> node DP alignment', (r) => (r.rd.flat.align ? r.rd.flat.align.exact : none)],
  ['rd-text+2/3', 'Readability text DP + 2/3 rule', (r) => (r.rd.flat.align ? r.rd.flat.align.withFuzzy : none)],
  ['rd-hybrid', 'Readability: id survival OR text alignment', (r) => new Set([...r.rd.flat.ids, ...(r.rd.flat.align ? r.rd.flat.align.exact : [])])],
  ['tr-text', 'Trafilatura text -> node DP alignment', (r) => (r.traf && r.traf.align ? r.traf.align.exact : none)],
  ['tr-text+2/3', 'Trafilatura text DP + 2/3 rule', (r) => (r.traf && r.traf.align ? r.traf.align.withFuzzy : none)],
];

export function countsFor(rec, method) {
  const kept = METHODS.find((m) => m[0] === method)[2](rec);
  return pageCounts(rec.snapshot, rec.truth, kept);
}

function table(rows, header) {
  const all = [header, ...rows].map((r) => r.map(String));
  const w = header.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => '| ' + r.map((c, i) => c.padEnd(w[i])).join(' | ') + ' |';
  return [line(all[0]), '|' + w.map((n) => '-'.repeat(n + 2)).join('|') + '|', ...all.slice(1).map(line)].join('\n');
}

export function categories(records) {
  return [...new Set(records.map((r) => r.category))];
}

/** Table 1: how many truth-main text elements keep their data-gp-id inside Readability's output. */
export function survivalTable(records) {
  const rows = [];
  const groups = [...categories(records).map((c) => [c, records.filter((r) => r.category === c)]), ['ALL', records]];
  for (const [cat, recs] of groups) {
    const a = sumCounts(recs.map((r) => countsFor(r, 'rd-attr')));
    const b = sumCounts(recs.map((r) => countsFor(r, 'rd-attr+shadow')));
    const sa = a.survival.main, sb = b.survival.main;
    // main elements whose TEXT is in Readability's output but whose id is not: attribute loss
    let lost = 0, textKept = 0;
    for (const r of recs) {
      const txt = r.rd.flat.align ? r.rd.flat.align.exact : none;
      for (const e of r.snapshot.elements) {
        if (!isEvaluable(e) || !r.truth[e.id] || r.truth[e.id].label !== 'main') continue;
        if (txt.has(e.id)) { textKept++; if (!r.rd.flat.ids.has(e.id)) lost++; }
      }
    }
    rows.push([cat, recs.length, sa.n, `${sa.kn} (${pct(sa.kn / sa.n)}%)`, `${sb.kn} (${pct(sb.kn / sb.n)}%)`, `${pct(sb.kc / sb.c)}%`, textKept, lost]);
  }
  return table(rows, ['category', 'pages', 'main elems', 'ids kept (plain clone)', 'ids kept (shadow inlined)', 'main chars kept', 'main kept by text', 'of which id lost']);
}

/** Over ALL labels: of the elements whose text Readability kept, how many lost their id? */
export function idLossAll(records) {
  let kept = 0, lost = 0;
  const byTag = {};
  for (const r of records) {
    const txt = r.rd.flat.align ? r.rd.flat.align.exact : none;
    for (const e of r.snapshot.elements) {
      if (!isEvaluable(e) || !txt.has(e.id)) continue;
      kept++;
      if (!r.rd.flat.ids.has(e.id)) { lost++; byTag[e.tag] = (byTag[e.tag] || 0) + 1; }
    }
  }
  return { kept, lost, byTag };
}

/** Table 2/3: precision/recall of "extractor kept" vs truth, per category and method. */
export function prTable(records, positive, scope, methods) {
  const rows = [];
  const groups = [...categories(records).map((c) => [c, records.filter((r) => r.category === c)]), ['ALL', records]];
  for (const [cat, recs] of groups) {
    const row = [cat];
    for (const m of methods) {
      const s = sumCounts(recs.map((r) => countsFor(r, m)));
      const { p, r, f1 } = prf(s[`${positive}.${scope}`], 'c');
      row.push(`${pct(p)} / ${pct(r)} / ${pct(f1)}`);
    }
    rows.push(row);
  }
  return table(rows, ['category (P/R/F1 %, char-weighted)', ...methods]);
}

/** Per-page row (verbose mode). */
export function pageTable(records) {
  const rows = records.map((r) => {
    const a = countsFor(r, 'rd-attr+shadow'), t = countsFor(r, 'rd-text'), s = a.survival.main;
    const pa = prf(a['main.all'], 'c'), pt = prf(t['main.all'], 'c');
    return [r.name, r.snapshot.elements.length, r.snapshot.texts.length, r.settled.reason + ' ' + r.settled.waitedMs + 'ms', r.unstampedLater, r.rd.flat.readerable, `${s.kn}/${s.n}`, `${pct(pa.p)}/${pct(pa.r)}`, `${pct(pt.p)}/${pct(pt.r)}`, pct(r.rd.flat.align ? r.rd.flat.align.coverage : NaN), r.uncoveredCount];
  });
  return table(rows, ['page', 'elems', 'text units', 'settle', 'unstamped later', 'readerable', 'main ids kept', 'attr P/R', 'text P/R', 'align coverage %', 'truth gaps']);
}

export { table };
