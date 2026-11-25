#!/usr/bin/env node
// Entry point.
//   node src/run.mjs --fixtures            run over fixtures/pages/*.html, print per-category tables
//   node src/run.mjs --url <u> [--url ..]  collect real pages into <repo>/data/collect-align/ (never committed)
// Flags: --out <dir>  --quiet-ms <n>  --no-settle  --verbose  --only <name>  --no-settle-experiment
// Env:   GP_CHROMIUM (browser binary), GP_TRAF_PYTHONPATH (dir holding the trafilatura package)
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, collectPage } from './collect.mjs';
import { processPage, trafilaturaAvailable, addTrafilatura } from './pipeline.mjs';
import { isEvaluable } from './metrics.mjs';
import { METHODS, idLossAll, survivalTable, prTable, pageTable, table } from './report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const optAll = (n) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));

function repoRoot() {
  let d = here;
  while (d !== dirname(d)) { if (existsSync(join(d, '.git'))) return d; d = dirname(d); }
  throw new Error('repo root not found');
}
const ROOT = repoRoot();
const collectOpts = { quietMs: Number(opt('--quiet-ms', 600)), settle: !flag('--no-settle') };

async function runFixtures() {
  const dir = join(ROOT, 'fixtures', 'pages');
  const only = opt('--only');
  const names = readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => basename(f, '.html')).filter((n) => !only || n === only).sort();
  const outDir = opt('--out', join(tmpdir(), 'gp-collect-align'));
  const { browser, context } = await launch();
  const records = [];
  for (const name of names) {
    const truthFile = JSON.parse(readFileSync(join(dir, `${name}.truth.json`), 'utf8'));
    const rec = await processPage(context, pathToFileURL(join(dir, `${name}.html`)).href, {
      name, category: truthFile.category, truthRules: truthFile.rules, outDir, collect: collectOpts,
    });
    rec.uncovered = rec.snapshot.elements.filter((e) => isEvaluable(e) && !(rec.truth[e.id] && rec.truth[e.id].label)).map((e) => `${e.id}<${e.tag}> ${e.ownText.slice(0, 40)}`);
    rec.uncoveredCount = rec.uncovered.length;
    records.push(rec);
  }
  const trafV = trafilaturaAvailable(process.env.GP_TRAF_PYTHONPATH);
  if (trafV) addTrafilatura(records, here, process.env.GP_TRAF_PYTHONPATH);

  const gaps = records.filter((r) => r.uncoveredCount);
  console.log(`\nFixtures: ${records.length} pages, snapshots in ${outDir}`);
  console.log(`trafilatura: ${trafV ? 'v' + trafV : 'NOT AVAILABLE (pip install --target <dir> trafilatura; set GP_TRAF_PYTHONPATH=<dir>)'}`);
  for (const rec of records) if (rec.deadRules.length) console.log(`WARNING ${rec.name}: truth selectors matching nothing: ${rec.deadRules.join(', ')}`);
  if (gaps.length) {
    console.log('\nTRUTH LINT: text elements not covered by any rule:');
    for (const r of gaps) console.log(`  ${r.name}: ${r.uncovered.slice(0, 8).join(' | ')}`);
  } else console.log('Truth lint: every text-bearing element is covered by a rule.');
  const det = await determinismCheck(context, dir, names);
  console.log(`Determinism: ${det.same}/${names.length} pages give identical (id, tag, parent) sequences on two independent loads${det.diff.length ? ' (differ: ' + det.diff.join(', ') + ')' : ''}.`);
  if (flag('--lint-truth')) { await browser.close(); process.exit(gaps.length ? 1 : 0); }

  console.log('\n## 1. Readability keeps data-gp-id? (truth-main text elements whose id is in Readability output)\n');
  console.log(survivalTable(records));
  const il = idLossAll(records);
  console.log(`\nAll labels: of ${il.kept} text elements whose text Readability kept, ${il.lost} (${(100 * il.lost / il.kept).toFixed(1)}%) lost their id; by tag: ${JSON.stringify(il.byTag)}`);
  const mset = ['rd-attr', 'rd-attr+shadow', 'rd-text', 'rd-hybrid', ...(trafV ? ['tr-text', 'tr-text+2/3'] : [])];
  const msub = ['rd-attr+shadow', 'rd-text', ...(trafV ? ['tr-text+2/3'] : [])];
  console.log('\n## 2. "Extractor-kept" vs truth, positive = main (all text elements)\n');
  console.log(prTable(records, 'main', 'all', mset));
  console.log('\n## 3. same, positive = main + support\n');
  console.log(prTable(records, 'ms', 'all', msub));
  console.log('\n## 4. same as 2, restricted to visible elements (what the extension would classify)\n');
  console.log(prTable(records, 'main', 'vis', msub));
  if (flag('--verbose')) { console.log('\n## per page\n'); console.log(pageTable(records)); }
  console.log('\nMethods:\n' + METHODS.map((m) => `  ${m[0]}: ${m[1]}`).join('\n'));

  if (!flag('--no-settle-experiment')) await settleExperiment(context, dir);
  await browser.close();
}

async function determinismCheck(context, dir, names) {
  const sig = (c) => c.snapshot.elements.map((e) => `${e.id}:${e.tag}:${e.parent}`).join('|');
  const diff = [];
  for (const n of names) {
    const url = pathToFileURL(join(dir, `${n}.html`)).href;
    const [a, b] = [await collectPage(context, url, collectOpts), await collectPage(context, url, collectOpts)];
    if (sig(a) !== sig(b)) diff.push(n);
  }
  return { same: names.length - diff.length, diff };
}

/** SPA pages: how much DOM does each wait strategy see? */
async function settleExperiment(context, dir) {
  const rows = [];
  for (const name of ['spa-1', 'spa-2']) {
    const url = pathToFileURL(join(dir, `${name}.html`)).href;
    const row = [name];
    for (const o of [{ settle: false }, { quietMs: 150, useNetworkIdle: false }, { quietMs: 600, useNetworkIdle: false }, { quietMs: 600 }]) {
      const c = await collectPage(context, url, o);
      const chars = c.snapshot.elements.reduce((s, e) => s + e.ownText.length, 0);
      row.push(`${c.snapshot.elements.length} el / ${chars} ch / ${c.settled.waitedMs}ms${c.unstampedLater ? ' (+' + c.unstampedLater + ' late)' : ''}`);
    }
    rows.push(row);
  }
  console.log('\n## 5. Settle strategy on SPA fixtures (elements / own-text chars / wait / elements added after stamping)\n');
  console.log(table(rows, ['page', 'no wait (load only)', 'DOM-quiet 150ms', 'DOM-quiet 600ms', 'networkidle + DOM-quiet 600ms']));
}

async function runUrls(urls) {
  const outRoot = opt('--out', join(ROOT, 'data', 'collect-align'));
  const trafV = trafilaturaAvailable(process.env.GP_TRAF_PYTHONPATH);
  const { browser, context } = await launch();
  const records = [];
  for (const url of urls) {
    const u = new URL(url);
    const name = (u.hostname + u.pathname).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60).toLowerCase();
    try {
      records.push(await processPage(context, url, { name, category: 'real', outDir: join(outRoot, name), collect: collectOpts }));
    } catch (e) {
      console.log(`FAILED ${url}: ${e.message}`);
    }
  }
  if (trafV && records.length) addTrafilatura(records, here, process.env.GP_TRAF_PYTHONPATH);
  const rows = records.map((r) => {
    const els = r.snapshot.elements;
    const textEls = els.filter((e) => e.ownText).length;
    const f = r.rd.flat;
    const attr = f.ids, txt = f.align ? f.align.exact : new Set();
    const textOwners = new Set(els.filter((e) => e.ownText).map((e) => e.id));
    const a = [...attr].filter((i) => textOwners.has(i)), inter = a.filter((i) => txt.has(i)).length;
    const uni = new Set([...a, ...txt]).size;
    return [r.name.slice(0, 40), els.length, textEls, `${r.settled.reason} ${r.settled.waitedMs}ms`, `${r.timings.loadMs}/${r.timings.stampMs}/${r.timings.snapshotMs}`, r.unstampedLater,
      els.filter((e) => e.shadowHost).length, els.filter((e) => e.tag === 'iframe').length,
      f.ok ? `${f.textLen} ch / ${f.ids.size} ids` : 'null', f.readerable,
      r.flags.join(',') || '-', f.align ? pctStr(f.align.coverage) : '-', uni ? pctStr(inter / uni) : '-',
      r.traf ? (r.traf.ok ? pctStr(r.traf.align.coverage) : 'null') : 'n/a'];
  });
  console.log('\nReal pages (stored under ' + outRoot + '; nothing here is committed)\n');
  console.log(table(rows, ['page', 'elems', 'text elems', 'settle', 'load/stamp/snapshot ms', 'unstamped later', 'shadow hosts', 'iframes', 'Readability out', 'readerable', 'flags', 'RD align cover %', 'attr~text agree %', 'TR align cover %']));
  for (const r of records) {
    const f = r.rd.flat, txt = f.align ? f.align.exact : new Set();
    const lost = {}, extra = {};
    for (const e of r.snapshot.elements) {
      if (!e.ownText) continue;
      if (txt.has(e.id) && !f.ids.has(e.id)) lost[e.tag] = (lost[e.tag] || 0) + 1;
      if (!txt.has(e.id) && f.ids.has(e.id)) extra[e.tag] = (extra[e.tag] || 0) + 1;
    }
    console.log(`${r.name}: text kept but id lost by tag ${JSON.stringify(lost)}; id kept but text not aligned ${JSON.stringify(extra)}`);
  }
  await browser.close();
}
const pctStr = (x) => (100 * x).toFixed(1);

const urls = optAll('--url');
if (flag('--fixtures')) await runFixtures();
else if (urls.length) await runUrls(urls);
else { console.log('usage: node src/run.mjs --fixtures | --url <url> [--url <url>...]'); process.exit(2); }
