// One page through the whole spike: collect -> (truth) -> Readability (attr + text) -> Trafilatura.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { collectPage, loadReadability, writeJson, pageFlags } from './collect.mjs';
import { alignText, keptElements } from './align.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

/** Run Readability twice in the live page: plain clone, and with open shadow roots inlined. */
async function readabilityRuns(page) {
  await loadReadability(page);
  const plain = await page.evaluate(() => window.__gp.runReadability({ flattenShadow: false }));
  const flat = await page.evaluate(() => window.__gp.runReadability({ flattenShadow: true }));
  return { plain, flat };
}

function alignRun(snapshot, text) {
  const { exact, fuzzy, coverage } = alignText(snapshot.texts, text);
  const both = new Set([...exact, ...fuzzy]);
  return {
    coverage,
    exact: keptElements(snapshot.texts, exact),
    withFuzzy: keptElements(snapshot.texts, both),
    fuzzyUnits: fuzzy.size,
    exactUnits: exact.size,
  };
}

/**
 * @param opts { name, category, truthRules?, outDir, collect }
 * Returns a record; sets inside are Sets (not JSON-serializable, see saveRecord).
 */
export async function processPage(context, url, opts) {
  const { name, category, truthRules, outDir, collect = {} } = opts;
  const c = await collectPage(context, url, { ...collect, keepPage: true });
  const page = c.page;
  try {
    const truth = truthRules ? await page.evaluate((r) => window.__gp.applyTruth(r), truthRules) : null;
    const deadRules = truthRules ? await page.evaluate((r) => r.filter((x) => !document.querySelector(x.selector)).map((x) => x.selector), truthRules) : [];
    const rd = await readabilityRuns(page);
    const flatHtml = await page.evaluate(() => window.__gp.flattenedHtml());
    mkdirSync(outDir, { recursive: true });
    const htmlPath = join(outDir, `${name}.stamped.html`);
    writeFileSync(htmlPath, flatHtml);
    const rec = {
      name, category, url, htmlPath, truth, deadRules,
      snapshot: c.snapshot, settled: c.settled, networkIdle: c.networkIdle,
      flags: pageFlags(c.snapshot), stampCount: c.stampCount, unstampedLater: c.unstampedLater, timings: c.timings,
      rd: {},
    };
    for (const [k, r] of Object.entries(rd)) {
      rec.rd[k] = {
        error: r.error || null,
        readerable: r.readerable,
        flattened: r.flattened,
        ok: !!r.article,
        textLen: r.article ? r.article.text.length : 0,
        ids: new Set(r.ids || []),
        text: r.article ? r.article.text : '',
        html: r.article ? r.article.html : '',
        align: r.article ? alignRun(c.snapshot, r.article.text) : null,
      };
    }
    writeJson(outDir, `${name}.snapshot.json`, {
      snapshot: c.snapshot, truth, settled: c.settled, stampCount: c.stampCount, unstampedLater: c.unstampedLater,
      readability: Object.fromEntries(Object.entries(rec.rd).map(([k, v]) => [k, { ok: v.ok, ids: [...v.ids], textLen: v.textLen }])),
    });
    return rec;
  } finally {
    await page.close();
  }
}

/** Is trafilatura importable with this PYTHONPATH? Returns its version or null. */
export function trafilaturaAvailable(pythonPath) {
  try {
    const env = { ...process.env, ...(pythonPath ? { PYTHONPATH: pythonPath } : {}) };
    return execFileSync('python3', ['-W', 'ignore', '-c', 'import trafilatura; print(trafilatura.__version__)'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return null;
  }
}

/** Extract text with trafilatura for every record (one python process), then align. */
export function addTrafilatura(records, here, pythonPath) {
  const env = { ...process.env, ...(pythonPath ? { PYTHONPATH: pythonPath } : {}) };
  const out = execFileSync('python3', ['-W', 'ignore', join(here, 'traf_extract.py'), ...records.map((r) => r.htmlPath)], { encoding: 'utf8', env, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  const parsed = JSON.parse(out);
  for (const r of records) {
    const text = parsed.results[r.htmlPath];
    r.traf = { version: parsed.version, ok: !!text, textLen: text ? text.length : 0, text: text || '', align: text ? alignRun(r.snapshot, text) : null };
  }
  return parsed.version;
}
