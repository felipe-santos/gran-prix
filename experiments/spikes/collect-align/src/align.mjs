// Text -> node alignment (Web2Text-flavoured, but simpler): given the DOM's text units in document
// order and the text an extractor produced, find which units the extractor kept.
//
// Idea: the extractor output is (almost) the concatenation of the kept units, in document order.
// So we look for the subsequence of units whose normalized concatenation covers the extractor text
// best. That is a monotone alignment solved by a small beam DP over "cursor in extractor text".
// Whitespace is stripped before matching because block boundaries lose their separators in
// textContent. A second, order-free pass applies the Web2Text 2/3 rule to rescue units the
// extractor edited slightly.

// Whitespace and the markup characters text extractors inject (table pipes, list dashes, heading
// hashes, quote/code marks) are dropped on BOTH sides, so Markdown-ish output still lines up.
const norm = (s) => s.normalize('NFKC').toLowerCase().replace(/[\s|#*>`_\-\u2013\u2014\u2022\u00b7]+/g, '');

const GAP_START = 400; // chars of extractor text that may precede the first kept unit (titles etc.)
const GAP = 16; // chars of extractor-only text allowed between two kept units (markup the tool added)
const GAP_COST = 3;
const BEAM = 200;
const FUZZY_MIN = 12; // units shorter than this are never rescued order-free
const SHORT = 25; // units below this need exact containment in E; longer ones use the 2/3 shingle rule
const SHINGLE = 8;

/**
 * @param {{id:string, owner:string, t:string}[]} texts snapshot.texts (document order)
 * @param {string} extracted extractor text
 * @returns {{exact:Set<string>, fuzzy:Set<string>, coverage:number}} kept text-unit ids
 */
export function alignText(texts, extracted) {
  const E = norm(extracted || '');
  const units = texts.map((u) => ({ id: u.id, n: norm(u.t) })).filter((u) => u.n.length > 0);
  // beam DP: state = cursor position in E; value = {score, prev, unit}
  let states = new Map([[0, { score: 0, prev: null, unit: null }]]);
  for (let k = 0; k < units.length; k++) {
    const { n } = units[k];
    const next = new Map(states); // option 1: unit not kept
    for (const [c, st] of states) {
      const maxGap = c === 0 ? GAP_START : GAP;
      const win = E.substr(c, maxGap + n.length);
      const p = win.indexOf(n);
      if (p < 0) continue;
      const gain = n.length - GAP_COST * p;
      if (gain <= 0) continue;
      const c2 = c + p + n.length;
      const score = st.score + gain;
      const old = next.get(c2);
      if (!old || old.score < score) next.set(c2, { score, prev: st, unit: k });
    }
    states = next;
    if (states.size > BEAM) {
      states = new Map([...states.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, BEAM));
    }
  }
  let best = null;
  for (const st of states.values()) if (!best || st.score > best.score) best = st;
  const exact = new Set();
  let covered = 0;
  for (let st = best; st && st.unit !== null; st = st.prev) {
    exact.add(units[st.unit].id);
    covered += units[st.unit].n.length;
  }
  // Order-free rescue for the rest (extractors may reorder or edit): exact containment for short units,
  // Web2Text 2/3 rule for long ones: share of the unit's 8-char shingles that occur anywhere in E.
  const sh = new Set();
  for (let i = 0; i + SHINGLE <= E.length; i++) sh.add(E.substr(i, SHINGLE));
  const fuzzy = new Set();
  for (const u of units) {
    if (exact.has(u.id) || u.n.length < FUZZY_MIN) continue;
    if (u.n.length < SHORT) { if (E.includes(u.n)) fuzzy.add(u.id); continue; }
    let hit = 0, tot = 0;
    for (let i = 0; i + SHINGLE <= u.n.length; i += 4) { tot++; if (sh.has(u.n.substr(i, SHINGLE))) hit++; }
    if (tot && hit / tot >= 2 / 3) fuzzy.add(u.id);
  }
  return { exact, fuzzy, coverage: E.length ? covered / E.length : 0 };
}

/** Element-level decision: an element is kept when >=50% of its own text chars are in kept units. */
export function keptElements(texts, keptUnitIds) {
  const tot = new Map(), kept = new Map();
  for (const u of texts) {
    const len = u.t.replace(/\s+/g, '').length;
    tot.set(u.owner, (tot.get(u.owner) || 0) + len);
    if (keptUnitIds.has(u.id)) kept.set(u.owner, (kept.get(u.owner) || 0) + len);
  }
  const out = new Set();
  for (const [o, t] of tot) if ((kept.get(o) || 0) >= 0.5 * t) out.add(o);
  return out;
}
