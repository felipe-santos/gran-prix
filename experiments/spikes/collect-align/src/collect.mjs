// Collect prototype: launch cached Chromium headless, load a page, wait for it to settle, stamp
// stable data-gp-id ids, capture a minimal snapshot. Reusable: import { launch, collectPage }.
import { chromium } from 'playwright-core';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const INPAGE = join(here, 'inpage.js');
const require_ = (p) => join(here, '..', 'node_modules', p);

/** Find a cached Chromium (env GP_CHROMIUM wins; else the newest ~/.cache/ms-playwright build). */
export function findChromium() {
  if (process.env.GP_CHROMIUM) return process.env.GP_CHROMIUM;
  const base = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(base)) return undefined; // let Playwright try its own default
  const builds = readdirSync(base)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const b of builds) {
    const exe = join(base, b, 'chrome-linux64', 'chrome');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

export async function launch() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Runs before any page script, in every frame: installs mutation tracking + the __gp API.
  await context.addInitScript({ path: INPAGE });
  return { browser, context };
}

/**
 * Load `url`, settle, stamp ids, snapshot. Returns everything needed for downstream steps.
 * opts: { quietMs, maxMs, settle (false = snapshot right after load), useNetworkIdle, keepPage }
 */
export async function collectPage(context, url, opts = {}) {
  const { quietMs = 600, maxMs = 8000, settle = true, keepPage = false, useNetworkIdle = true } = opts;
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  const tLoad = Date.now() - t0;
  let networkIdle = false;
  if (settle && useNetworkIdle) {
    // Best effort only: chatty pages never reach networkidle, so cap it; the DOM-quiet check decides.
    networkIdle = await page.waitForLoadState('networkidle', { timeout: 3000 }).then(() => true, () => false);
  }
  const settled = settle ? await page.evaluate((o) => window.__gp.settle(o), { quietMs, maxMs }) : { reason: 'none', waitedMs: 0, mutations: null };
  const tS = Date.now();
  const stampCount = await page.evaluate(() => window.__gp.stampIds());
  const tSnap = Date.now();
  const snapshot = await page.evaluate(() => window.__gp.snapshot());
  const tEnd = Date.now();
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  // Late-mutation probe: anything added after stamping has no id (evidence for the timing rule).
  await page.waitForTimeout(500);
  const unstampedLater = await page.evaluate(() => window.__gp.countUnstamped());
  const timings = { loadMs: tLoad, stampMs: tSnap - tS, snapshotMs: tEnd - tSnap, totalMs: Date.now() - t0 };
  const result = { snapshot, html, settled, networkIdle, stampCount, unstampedLater, timings };
  if (keepPage) result.page = page; else await page.close();
  return result;
}

/** Inject Readability (+ readerable check) into a live page via CDP evaluate (not blocked by CSP). */
export async function loadReadability(page) {
  const src = ['Readability.js', 'Readability-readerable.js']
    .map((f) => readFileSync(require_(join('@mozilla', 'readability', f)), 'utf8'))
    .join('\n;\n');
  await page.evaluate(src + '\n;window.Readability = Readability; window.isProbablyReaderable = isProbablyReaderable;');
}

/** Cheap "this is not the page" detector (E1.5 wants paywall/captcha/error marks). Heuristic only. */
export function pageFlags(snapshot) {
  const text = snapshot.elements.map((e) => e.ownText).join(' ');
  const flags = [];
  if (/too many requests|rate limit|access denied|forbidden|service unavailable|error 4\d\d|error 5\d\d/i.test(snapshot.title + ' ' + text.slice(0, 600))) flags.push('error-page');
  if (/captcha|verify you are human|just a moment|checking your browser|unusual traffic/i.test(text)) flags.push('captcha/challenge');
  if (/subscribe to (continue|read)|sign in to (continue|read)|create a free account to read|you have reached your (free )?limit/i.test(text)) flags.push('paywall?');
  if (snapshot.elements.length < 60 && text.length < 800) flags.push('tiny-dom');
  return flags;
}

export function writeJson(dir, name, obj) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
