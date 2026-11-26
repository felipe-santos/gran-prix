import { median, ms2, nearestRank, summarize, type Summary } from "./stats.js";
import type { ModelSizes } from "./model-js.js";
import type { RunnerResult } from "./page-script.js";

export const LATENCY_FORMAT = "gran-prix.latency-report";

/** Protocol limits of G5 (`pipelines/dom-v0-decision.json` carries the same numbers for the decision script). */
export const G5_P95_MS_MAX = 150;
export const G5_MODEL_BYTES_MAX = 100_000;

/** One timed load of one page. */
export interface Sample extends Omit<RunnerResult, "features" | "scores"> {
  rank: number;
  snapshot_id: string;
  stratum: string;
  /** 1-based repetition. */
  rep: number;
}

export interface PageInfo {
  rank: number;
  snapshot_id: string;
  stratum: string;
  url_key: string;
  order_key: string;
  /** `nodes.length` of the stored snapshot. */
  snapshot_nodes: number;
}

export interface ReportInput {
  label: string;
  samples: Sample[];
  pages: PageInfo[];
  selection: { order_prefix: string; element_range: [number, number]; requested: number; eligible: number; total: number; shortfall: boolean };
  repetitions: number;
  cpu_throttle: number;
  environment: { browser: string; user_agent?: string; executable?: string; viewport: [number, number]; platform: string; cpus: number; node: string };
  throttle_check: { unthrottled_ms: number; throttled_ms: number; ratio: number } | null;
  load: { before: number[]; after: number[] };
  model: { model_id: string; name: string; shape: number[]; activation: string; sizes: ModelSizes };
  parity: { checked: boolean; rows: number; max_abs_diff: number | null; tolerance: number } | null;
  params: Record<string, unknown>;
  warnings: string[];
}

const COMPONENTS = ["probe_ms", "vectorize_ms", "init_ms", "infer_ms", "total_ms"] as const;
type Component = (typeof COMPONENTS)[number];

const round = (s: Summary): Summary => ({ n: s.n, p50: ms2(s.p50), p95: ms2(s.p95), max: ms2(s.max), mean: ms2(s.mean) });

/** The DEFINITIONS the numbers rest on, written into the report so it can be read without the code. */
export const PROTOCOL_TEXT = {
  sample: "One timed load of one page: a fresh browser context and page, CPU throttled, the page loaded to the load event with every other request aborted, then ONE run of probe + vectorize + model init + inference inside the page.",
  total_ms: "performance.now() inside the page from the start of the probe to the end of the scoring of every row. It includes probe (no settle wait), vectorize, evaluation of the generated model module, z-score, forward pass, calibration and activation. It excludes navigation, network, Playwright/CDP round trips, the 600 ms DOM-quiet wait of settle (wall clock, not CPU) and the evaluation of the features bundle (done at document start, part of the page load). The clock starts after the page has rendered params.wait_frames frames (default 2), so style and layout are clean as they are after the real settle wait; with wait_frames 0 the page's first layout falls inside the probe (a pessimistic bound).",
  throttle: "CDP Emulation.setCPUThrottlingRate on the page. throttle_check runs a ~100 ms busy loop unthrottled and throttled: in Chromium 158 the slowdown of a task of that size is well under the requested rate, so the throttled numbers are OPTIMISTIC relative to a true Nx slower CPU. A run with cpu_throttle 1 on the same pages shows the effective slowdown.",
  p95: "Nearest-rank p95 of total_ms over ALL samples (pages x repetitions). per_page_median_p95 (the p95 over the pages' median total) is reported beside it.",
  repetitions: "All repetitions count. Every repetition is a cold page (new context, new renderer state), so the first one is not warmer or colder than the others; the only thing discarded is one untimed throwaway page load that starts the browser. by_repetition shows whether repetition 1 differs.",
  pages: "Flattened html of the frozen SnapshotSet served from memory: no scripts, no external css, images or fonts. The DOM is therefore static and its layout cheaper or different from the live page. This is an approximation; the real G5 is measured by E4 in the extension.",
  size: "model_bytes = weights.f32le + network_def.json + model.json (package_bytes). extension_bytes = model.generated.ts + model.json is what an extension would embed (weights as base64 inside the module, unminified); the size gate passes only when BOTH are within the limit.",
} as const;

export function buildReport(r: ReportInput): Record<string, unknown> {
  if (r.samples.length === 0) throw new Error("no samples to report");
  const col = (c: Component): number[] => r.samples.map((s) => s[c]);
  const components = Object.fromEntries(COMPONENTS.map((c) => [c.replace(/_ms$/, ""), round(summarize(col(c)))]));
  const total = summarize(col("total_ms"));

  const byRep = Array.from({ length: r.repetitions }, (_, i) => {
    const t = r.samples.filter((s) => s.rep === i + 1).map((s) => s.total_ms);
    return t.length === 0 ? { rep: i + 1, n: 0 } : { rep: i + 1, ...round(summarize(t)) };
  });

  const perPage = r.pages.map((p) => {
    const mine = r.samples.filter((s) => s.rank === p.rank);
    const totals = mine.map((s) => s.total_ms);
    return {
      ...p,
      elements_probed: mine[0]?.elements ?? null,
      rows: mine[0]?.rows ?? null,
      total_ms: totals.map(ms2),
      probe_ms: mine.map((s) => ms2(s.probe_ms)),
      vectorize_ms: mine.map((s) => ms2(s.vectorize_ms)),
      init_ms: mine.map((s) => ms2(s.init_ms)),
      infer_ms: mine.map((s) => ms2(s.infer_ms)),
      median_total_ms: totals.length > 0 ? ms2(median(totals)) : null,
    };
  });
  const medians = perPage.map((p) => p.median_total_ms).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const perPageP95 = medians.length > 0 ? ms2(nearestRank(medians, 95)) : null;

  const elements = r.samples.map((s) => s.elements);
  const nPages = new Set(r.samples.map((s) => s.rank)).size;
  const p95 = ms2(total.p95);
  const sz = r.model.sizes;
  const sizeOk = sz.package_bytes <= G5_MODEL_BYTES_MAX && sz.extension_bytes <= G5_MODEL_BYTES_MAX;
  const environment = `chromium-headless ${r.environment.browser}, ${r.cpu_throttle}x CPU throttle (CDP Emulation.setCPUThrottlingRate), ${r.environment.cpus} cores, ${r.environment.platform}`;

  return {
    format: LATENCY_FORMAT,
    format_version: "1.0.0",
    label: r.label,
    protocol: PROTOCOL_TEXT,
    intrinsic: {
      runtime: {
        p95_ms: p95,
        model_bytes: sz.package_bytes,
        n_pages: nPages,
        p50_ms: ms2(total.p50),
        cpu_throttle: r.cpu_throttle,
        repetitions: r.repetitions,
        environment,
        page_elements: [Math.min(...elements), Math.max(...elements)],
      },
    },
    gates: [
      {
        id: "g5_p95_latency", name: "G5 p95 latency (probe + vectorize + inference)", rule: `p95 <= ${G5_P95_MS_MAX} ms`,
        value: p95, passed: p95 <= G5_P95_MS_MAX, comparator: "<=", threshold: G5_P95_MS_MAX, unit: "ms", observed: p95,
      },
      {
        id: "g5_model_size", name: "G5 model size", rule: `model <= ${G5_MODEL_BYTES_MAX} bytes (package and extension artifact)`,
        value: Math.max(sz.package_bytes, sz.extension_bytes), passed: sizeOk, comparator: "<=", threshold: G5_MODEL_BYTES_MAX, unit: "bytes", observed: Math.max(sz.package_bytes, sz.extension_bytes),
      },
    ],
    latency_ms: {
      ...components,
      per_page_median_p95: perPageP95,
      by_repetition: byRep,
      timer_floor_p50: ms2(median(r.samples.map((s) => s.timer_floor_ms))),
    },
    size_bytes: { ...sz, limit: G5_MODEL_BYTES_MAX },
    model: r.model,
    selection: r.selection,
    environment: r.environment,
    throttle_check: r.throttle_check,
    load_average: { ...r.load, note: "1, 5 and 15 minute load average before and after the run; the machine was shared with other jobs." },
    parity: r.parity,
    params: r.params,
    warnings: r.warnings,
    per_page: perPage,
  };
}
