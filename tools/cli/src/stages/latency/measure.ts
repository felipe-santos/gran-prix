import { readFileSync } from "node:fs";
import { cpus, loadavg, platform } from "node:os";
import { join } from "node:path";
import { SnapshotSetReader, type FileSource } from "@gran-prix/labels";
import { loadModelPackage } from "@gran-prix/model";
import { buildPageModel } from "./model-js.js";
import { calibrateRate, type Calibration } from "./calibrate.js";
import { BUSY_LOOP, PAGE_RUNNER, type RunnerResult } from "./page-script.js";
import { buildReport, type PageInfo, type Sample } from "./report.js";
import { G5_ORDER_PREFIX, G5_MAX_ELEMENTS, G5_MIN_ELEMENTS, G5_MIN_PAGES, selectPages, type Candidate } from "./select.js";

/** `@gran-prix/features` is loaded on demand: Playwright is paid only by the stages that need a browser. */
type FeaturesModule = typeof import("@gran-prix/features");
type Browser = Awaited<ReturnType<FeaturesModule["launch"]>>["browser"];

export interface MeasureOptions {
  /** A SnapshotSet (collect's output layout). */
  snapshots: FileSource;
  /** Directory of a ModelPackage (model.json, network_def.json, weights.f32le, golden.json). */
  modelDir: string;
  pages?: number;
  repetitions?: number;
  /** The slowdown to measure under (4 for G5). With `throttle: "cdp-rate"` it is also the CDP rate; with "calibrated" the rate is searched. */
  cpuThrottle?: number;
  /**
   * "cdp-rate" (default): `Emulation.setCPUThrottlingRate(cpuThrottle)`, whose effect on a ~100 ms task is well under the rate.
   * "calibrated": the CDP rate whose effect on the reference busy loop is `cpuThrottle`x (see calibrate.ts), recorded in the report.
   */
  throttle?: "cdp-rate" | "calibrated";
  minElements?: number;
  maxElements?: number;
  orderPrefix?: string;
  viewport?: { width: number; height: number };
  /** Frames the page renders before the clock starts (default 2: style and layout are clean, as after the real settle wait). 0 keeps the page's first layout inside the probe. */
  waitFrames?: number;
  /** Write data-gp-id into the DOM like the collector's probe does (default true; an upper bound for the extension). */
  stamp?: boolean;
  /** Compare the in-page scores of the first measured load with `@gran-prix/model` in Node (default true). */
  verify?: boolean;
  /** Free text recorded in the report (what this run is: official or descriptive, which model). */
  label?: string;
  /** Fail unless the browser version starts with this (the pin). */
  expectBrowser?: string;
  navTimeoutMs?: number;
  log?: (message: string) => void;
}

const PAGE_URL = "http://g5.test/page.html";
const PARITY_TOLERANCE = 1e-5;

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";

interface PageData {
  info: PageInfo;
  html: string;
}

async function oneLoad(
  browser: Browser,
  bundle: string,
  html: string,
  o: { cpuThrottle: number; viewport: { width: number; height: number }; navTimeoutMs: number; args: unknown },
): Promise<RunnerResult> {
  const context = await browser.newContext({ viewport: o.viewport });
  try {
    await context.addInitScript({ content: bundle });
    // The page comes from memory; every other request (images, fonts, trackers) is refused at once, so the load does
    // not depend on the network and the run can be repeated offline.
    await context.route("**/*", (route) =>
      route.request().url() === PAGE_URL ? route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }) : route.abort(),
    );
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: o.cpuThrottle });
    await page.goto(PAGE_URL, { waitUntil: "load", timeout: o.navTimeoutMs });
    // A string is an expression for Playwright (not a function to call), so the call is written out.
    return (await page.evaluate(`(${PAGE_RUNNER})(${JSON.stringify(o.args)})`)) as RunnerResult;
  } finally {
    await context.close();
  }
}

type ThrottleCheck = { cdp_rate: number; unthrottled_ms: number; throttled_ms: number; ratio: number };

/** A blank page with a CDP session; `bestAt(rate)` is the best (smallest) of five runs of the reference busy loop with the CDP rate set to `rate`. */
async function withLoopPage<T>(browser: Browser, f: (bestAt: (rate: number) => Promise<number>) => Promise<T>): Promise<T> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const bestAt = async (rate: number): Promise<number> => {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate });
      let min = Infinity;
      for (let i = 0; i < 5; i++) min = Math.min(min, ((await page.evaluate(`(${BUSY_LOOP})()`)) as { ms: number }).ms);
      return min;
    };
    return await f(bestAt);
  } finally {
    await context.close();
  }
}

/** Runs the reference busy loop unthrottled and with CDP rate `rate` in a blank page; the ratio shows what the throttle really does. */
async function throttleCheck(browser: Browser, rate: number): Promise<ThrottleCheck> {
  return withLoopPage(browser, async (bestAt) => {
    const unthrottled = await bestAt(1);
    const throttled = await bestAt(rate);
    return { cdp_rate: rate, unthrottled_ms: Math.round(unthrottled * 100) / 100, throttled_ms: Math.round(throttled * 100) / 100, ratio: Math.round((throttled / unthrottled) * 100) / 100 };
  });
}

/** Largest |difference| between the in-page scores and `@gran-prix/model` run in Node on the same feature rows. */
function parityOf(modelDir: string, features: number[], scores: number[], dim: number, outputDim: number): number {
  const loaded = loadModelPackage(modelDir, { runtime: "ts" });
  try {
    const n = features.length / dim;
    const expected = loaded.predictBatch(features, n);
    let max = 0;
    for (let i = 0; i < expected.length; i++) max = Math.max(max, Math.abs((expected[i] as number) - (scores[i] as number)));
    if (expected.length !== n * outputDim) throw new Error("the model returned an unexpected number of outputs");
    return max;
  } finally {
    loaded.dispose();
  }
}

export async function measureLatency(o: MeasureOptions): Promise<Record<string, unknown>> {
  const log = o.log ?? (() => undefined);
  const repetitions = o.repetitions ?? 3;
  const cpuThrottle = o.cpuThrottle ?? 4;
  const throttleMode = o.throttle ?? "cdp-rate";
  if (throttleMode !== "cdp-rate" && throttleMode !== "calibrated") throw new Error(`throttle must be "cdp-rate" or "calibrated", got ${String(throttleMode)}`);
  const viewport = o.viewport ?? { width: 1280, height: 900 };
  const wantPages = o.pages ?? G5_MIN_PAGES;
  const range: [number, number] = [o.minElements ?? G5_MIN_ELEMENTS, o.maxElements ?? G5_MAX_ELEMENTS];
  const orderPrefix = o.orderPrefix ?? G5_ORDER_PREFIX;
  const stamp = o.stamp !== false;
  const waitFrames = o.waitFrames ?? 2;
  const verify = o.verify !== false;
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error(`repetitions must be a positive integer, got ${repetitions}`);
  if (!(cpuThrottle >= 1)) throw new Error(`cpu_throttle must be >= 1, got ${cpuThrottle}`);

  // The model first: a package that does not pass its nine checks is not measured.
  const checked = loadModelPackage(o.modelDir, { runtime: "ts" });
  const modelId = checked.modelId;
  checked.dispose();
  const pm = buildPageModel({ file: (p) => new Uint8Array(readFileSync(join(o.modelDir, p))) });

  const reader = new SnapshotSetReader(o.snapshots);
  const candidates = reader.entries().map((e) => ({ entry: e, snapshot_id: e.snapshot_id, url: e.url, nodes: reader.snapshot(e).nodes.length }));
  const sel = selectPages<Candidate & { entry: (typeof candidates)[number]["entry"] }>(candidates, { orderPrefix, minElements: range[0], maxElements: range[1], count: wantPages });
  const warnings: string[] = [];
  if (sel.selected.length === 0) throw new Error(`no page of the set has ${range[0]} to ${range[1]} elements (${sel.total} pages)`);
  if (sel.shortfall) warnings.push(`only ${sel.eligible} pages have ${range[0]}-${range[1]} elements, fewer than the ${wantPages} requested: all of them were used`);
  log(`selected ${sel.selected.length} of ${sel.eligible} eligible pages (${sel.total} in the set)`);

  const pages: PageData[] = sel.selected.map((c) => ({
    info: { rank: c.rank, snapshot_id: c.snapshot_id, stratum: c.entry.stratum, url_key: reader.snapshot(c.entry).page.url_key, order_key: c.order_key, snapshot_nodes: c.nodes },
    html: reader.html(c.entry),
  }));

  const features: FeaturesModule = await import("@gran-prix/features");
  const bundle = features.bundleSource();
  const schema = features.featureSchemaV0;
  if (schema.dim !== pm.spec.dim) throw new Error(`the model takes ${pm.spec.dim} features but FeatureSchema v0 has ${schema.dim}`);
  const launched = await features.launch({ viewport });
  await launched.context.close();
  const browser = launched.browser;
  const loadBefore = loadavg().map((v) => Math.round(v * 100) / 100);
  try {
    const version = browser.version();
    if (o.expectBrowser !== undefined && !version.startsWith(o.expectBrowser)) throw new Error(`browser ${version} does not match the pin "${o.expectBrowser}"`);
    log(`chromium ${version}, throttle ${cpuThrottle}x (${throttleMode}), ${repetitions} repetitions`);

    let calibration: Calibration | null = null;
    let cdpRate = cpuThrottle;
    if (throttleMode === "calibrated" && cpuThrottle > 1) {
      calibration = await withLoopPage(browser, (bestAt) => calibrateRate(bestAt, { target: cpuThrottle }));
      cdpRate = calibration.rate;
      log(`calibration: CDP rate ${cdpRate} makes the reference loop x${calibration.ratio} slower (target ${cpuThrottle}, ${calibration.steps.length} steps${calibration.converged ? "" : ", NOT converged"})`);
      if (!calibration.converged) warnings.push(`the throttle calibration did not reach x${cpuThrottle} +- ${calibration.tolerance} in ${calibration.steps.length} steps: the closest was CDP rate ${cdpRate} (x${calibration.ratio})`);
    }
    const check = cpuThrottle > 1 ? await throttleCheck(browser, cdpRate) : null;
    if (check !== null) {
      log(`throttle check: CDP rate ${check.cdp_rate}, busy loop ${check.unthrottled_ms} ms -> ${check.throttled_ms} ms (x${check.ratio})`);
      if (check.ratio < cpuThrottle * 0.6) warnings.push(`the busy-loop check slowed down by x${check.ratio}, well under the requested ${cpuThrottle}x: the throttle may not be fully effective`);
    }

    const args = { moduleBody: pm.moduleBody, schema, spec: pm.spec, stamp, waitFrames, verify: false };
    const run = { cpuThrottle: cdpRate, viewport, navTimeoutMs: o.navTimeoutMs ?? 60_000 };
    // One throwaway load starts the browser's own machinery (renderer process, caches); it is never timed.
    await oneLoad(browser, bundle, (pages[0] as PageData).html, { ...run, args });

    const samples: Sample[] = [];
    let parity: { checked: boolean; rows: number; max_abs_diff: number | null; tolerance: number } | null = verify ? { checked: false, rows: 0, max_abs_diff: null, tolerance: PARITY_TOLERANCE } : null;
    for (let rep = 1; rep <= repetitions; rep++) {
      for (const p of pages) {
        const wantVerify = verify && parity !== null && !parity.checked;
        let res: RunnerResult;
        try {
          res = await oneLoad(browser, bundle, p.html, { ...run, args: { ...args, verify: wantVerify } });
        } catch (e) {
          throw new Error(`page ${p.info.rank} (${p.info.snapshot_id.slice(7, 19)}), repetition ${rep}: ${firstLine(e)}`);
        }
        if (wantVerify && res.features && res.scores && parity) {
          parity = { checked: true, rows: res.rows, max_abs_diff: parityOf(o.modelDir, res.features, res.scores, pm.spec.dim, pm.spec.outputDim), tolerance: PARITY_TOLERANCE };
          if ((parity.max_abs_diff as number) > PARITY_TOLERANCE) warnings.push(`the in-page scores differ from @gran-prix/model by ${parity.max_abs_diff} (tolerance ${PARITY_TOLERANCE})`);
        }
        const { features: _f, scores: _s, ...rest } = res;
        samples.push({ ...rest, rank: p.info.rank, snapshot_id: p.info.snapshot_id, stratum: p.info.stratum, rep });
      }
      const mine = samples.filter((s) => s.rep === rep).map((s) => s.total_ms).sort((a, b) => a - b);
      log(`repetition ${rep}/${repetitions}: median ${Math.round((mine[Math.floor(mine.length / 2)] as number) * 10) / 10} ms, max ${Math.round((mine[mine.length - 1] as number) * 10) / 10} ms (load ${loadavg()[0]?.toFixed(1)})`);
    }

    const ua = (await (async () => {
      const ctx = await browser.newContext();
      try {
        return (await (await ctx.newPage()).evaluate("navigator.userAgent")) as string;
      } finally {
        await ctx.close();
      }
    })());
    // Calibrated runs check the throttle again at the end: a machine that got busier in between shows up as a drift.
    const checkAfter = calibration !== null ? await throttleCheck(browser, cdpRate) : null;
    if (checkAfter !== null) {
      log(`throttle check after the run: x${checkAfter.ratio}`);
      if (Math.abs(checkAfter.ratio - cpuThrottle) > 0.5) warnings.push(`the calibrated throttle drifted during the run: x${check?.ratio} before, x${checkAfter.ratio} after (target ${cpuThrottle})`);
    }
    const loadAfter = loadavg().map((v) => Math.round(v * 100) / 100);
    return buildReport({
      label: o.label ?? "descriptive",
      samples,
      pages: pages.map((p) => p.info),
      selection: { order_prefix: orderPrefix, element_range: range, requested: wantPages, eligible: sel.eligible, total: sel.total, shortfall: sel.shortfall },
      repetitions,
      cpu_throttle: cpuThrottle,
      throttle: { mode: throttleMode, target: cpuThrottle, cdp_rate: cdpRate, calibration, check_after: checkAfter },
      environment: { browser: version, user_agent: ua, executable: features.findChromium(), viewport: [viewport.width, viewport.height], platform: `${platform()} ${process.arch}`, cpus: cpus().length, node: process.version },
      throttle_check: check,
      load: { before: loadBefore, after: loadAfter },
      model: { model_id: modelId, name: pm.manifest.name, shape: pm.shape, activation: pm.manifest.output_spec.activation, sizes: pm.sizes },
      parity,
      params: { pages: wantPages, repetitions, cpu_throttle: cpuThrottle, throttle: throttleMode, stamp, wait_frames: waitFrames, verify, viewport: [viewport.width, viewport.height] },
      warnings,
    });
  } finally {
    await browser.close();
  }
}
