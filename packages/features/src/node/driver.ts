// Node driver around the in-page bundle (Playwright). The extension will inject the same bundle as a
// content script; this is the collector-side path (E1.5 builds on it).
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "../api.js";
import type { ProbeOptions, RawProbe } from "../probe-types.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Path of the built IIFE: `dist/gp-features.iife.js` (src/node/ in tests, dist/node/ when compiled). */
export function bundlePath(): string {
  for (const p of [join(here, "..", "..", "dist", "gp-features.iife.js"), join(here, "..", "gp-features.iife.js")]) {
    if (existsSync(p)) return p;
  }
  throw new Error("gp-features.iife.js not found: run `pnpm --filter @gran-prix/features build:bundle`");
}

export function bundleSource(): string {
  return readFileSync(bundlePath(), "utf8");
}

/** GP_CHROMIUM wins; otherwise the newest cached Playwright Chromium. */
export function findChromium(): string | undefined {
  if (process.env["GP_CHROMIUM"]) return process.env["GP_CHROMIUM"];
  const base = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(base)) return undefined;
  const builds = readdirSync(base)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const b of builds) {
    const exe = join(base, b, "chrome-linux64", "chrome");
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

export interface Launched {
  browser: Browser;
  context: BrowserContext;
}

/** Headless Chromium whose every page gets the bundle before any page script runs (document start). */
export async function launch(opts: { viewport?: { width: number; height: number } } = {}): Promise<Launched> {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 900 } });
  await context.addInitScript({ content: bundleSource() });
  return { browser, context };
}

export interface ProbePageOptions extends ProbeOptions {
  /** Cap of the best-effort networkidle wait, default 3000 ms. */
  networkIdleCapMs?: number;
}

export interface ProbedPage {
  raw: RawProbe;
  /** Did the page reach networkidle within the cap? */
  network: "idle" | "timeout";
  /** Rendered HTML, `document.documentElement.outerHTML` (read through the prototype getters), taken right after the probe. */
  html: string;
}

/** Settle (load is the caller's job, then networkidle capped, then DOM-quiet in the page) and probe. */
export async function probeLoadedPage(page: Page, opts: ProbePageOptions = {}): Promise<ProbedPage> {
  const { networkIdleCapMs = 3000, ...probeOpts } = opts;
  const network = await page.waitForLoadState("networkidle", { timeout: networkIdleCapMs }).then(
    () => "idle" as const,
    () => "timeout" as const,
  );
  const raw = await page.evaluate((o) => {
    const api = window.__gpFeatures;
    if (!api) throw new Error("gp-features bundle is not installed in this page");
    return api.probe(o);
  }, probeOpts);
  // Through the prototype getters: a page can shadow `document.documentElement` with <img name="documentElement">.
  const html = await page.evaluate(() => {
    const get = (proto: object, key: string) => (Object.getOwnPropertyDescriptor(proto, key) as PropertyDescriptor).get as () => unknown;
    const root = get(Document.prototype, "documentElement").call(document) as Element;
    return get(Element.prototype, "outerHTML").call(root) as string;
  });
  return { raw, network, html };
}
