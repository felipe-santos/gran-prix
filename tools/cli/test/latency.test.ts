// L5g: ts:measure.latency@1.0.0 (G5). Pure parts (page selection, percentiles, the report and how the decision script
// reads it) run everywhere; the browser parts load 2-3 of the 6 synthetic fixture pages once, with the 4x CPU throttle,
// into the real stage. They check the SHAPE of the result and its parity with @gran-prix/model, never a time.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModelPackage } from "@gran-prix/model";
import { featureSchemaV0 } from "@gran-prix/features";
import { SnapshotSetReader } from "@gran-prix/labels";
import type { PipelineSpec } from "@gran-prix/contracts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
// @ts-expect-error plain .mjs without declarations
import { decide } from "../../../scripts/decide-dom-v0.mjs";
import { ArtifactStore, StageRegistry, checkPipeline, dataPaths, runPipeline } from "../src/index.js";
import { ALL_STAGES } from "../src/stages/index.js";
import { G5_ORDER_PREFIX, LATENCY_IMPL, buildSyntheticModel, calibrateRate, measureLatency, orderKey, selectPages, writeModelPackage } from "../src/stages/latency/index.js";
import { buildReport, type Sample } from "../src/stages/latency/report.js";
import { nearestRank, summarize } from "../src/stages/latency/stats.js";
import { buildPageModel } from "../src/stages/latency/model-js.js";
import { GO, evidenceOf } from "./decide-fixtures.js";
import { corpusExternals } from "./baselines-helpers.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(REPO, "pipelines/dom-v0-decision.json"), "utf8")) as Record<string, unknown>;
const corpus = inject("corpusDir");
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

describe("page selection (G5: 1,500-3,000 elements, order of sha256(prefix + url))", () => {
  const mk = (n: number, nodes: number) => ({ snapshot_id: `sha256:${sha(`snap${n}`)}`, url: `https://site${n}.example/page`, nodes });
  const pool = Array.from({ length: 60 }, (_, i) => mk(i, 1000 + i * 50)); // 1000 .. 3950

  it("keeps only the pages inside the range, both ends included", () => {
    const edges = [mk(100, 1499), mk(101, 1500), mk(102, 3000), mk(103, 3001)];
    const s = selectPages(edges, { count: 10 });
    expect(s.selected.map((p) => p.nodes).sort()).toEqual([1500, 3000]);
    expect(s.eligible).toBe(2);
    expect(s.total).toBe(4);
    expect(s.shortfall).toBe(true);
  });

  it("orders by the hash of the prefix and the url, takes the first `count`, and is independent of the input order", () => {
    const s = selectPages(pool, { count: 20 });
    expect(s.shortfall).toBe(false);
    expect(s.selected).toHaveLength(20);
    const inRange = pool.filter((p) => p.nodes >= 1500 && p.nodes <= 3000);
    const expected = inRange.map((p) => ({ p, key: sha(G5_ORDER_PREFIX + p.url) })).sort((a, b) => (a.key < b.key ? -1 : 1)).slice(0, 20).map((x) => x.p.url);
    expect(s.selected.map((p) => p.url)).toEqual(expected);
    expect(s.selected.map((p) => p.rank)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(s.selected[0]?.order_key).toBe(orderKey(G5_ORDER_PREFIX, s.selected[0]?.url as string));
    const shuffled = [...pool].reverse();
    expect(selectPages(shuffled, { count: 20 }).selected.map((p) => p.url)).toEqual(expected);
  });

  it("uses every page and says so when fewer than `count` are in range", () => {
    const s = selectPages(pool, { count: 100 });
    expect(s.shortfall).toBe(true);
    expect(s.selected).toHaveLength(s.eligible);
  });

  it("a different prefix gives a different order; an empty range is refused", () => {
    const a = selectPages(pool, { count: 5 }).selected.map((p) => p.url);
    const b = selectPages(pool, { count: 5, orderPrefix: "other|" }).selected.map((p) => p.url);
    expect(a).not.toEqual(b);
    expect(() => selectPages(pool, { minElements: 10, maxElements: 5 })).toThrow(/empty/);
  });
});

describe("percentiles (nearest rank)", () => {
  it("p95 of 1..20 is 19 and of 1..60 is 57; p50 and max follow", () => {
    const v20 = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(nearestRank(v20, 95)).toBe(19);
    const s = summarize(Array.from({ length: 60 }, (_, i) => 60 - i));
    expect(s).toMatchObject({ n: 60, p50: 30, p95: 57, max: 60 });
    expect(s.mean).toBeCloseTo(30.5, 10);
  });
  it("one sample is its own percentile; no sample is an error", () => {
    expect(summarize([7])).toMatchObject({ p50: 7, p95: 7, max: 7 });
    expect(() => summarize([])).toThrow();
  });
});

describe("throttle calibration (pure search over a fake reference loop)", () => {
  // The real loop gets less than `rate` times slower; model that as ratio = rate^0.6 (a 100 ms loop).
  const sublinear = (exp: number, jitter = 0) => {
    let n = 0;
    return async (rate: number): Promise<number> => 100 * Math.pow(rate, exp) * (1 + jitter * Math.sin(++n * 12.9898));
  };

  it("finds the rate whose slowdown is the target, from below (4^(1/0.6) = 10.08)", async () => {
    const c = await calibrateRate(sublinear(0.6), { target: 4 });
    expect(c.converged).toBe(true);
    expect(Math.abs(c.ratio - 4)).toBeLessThanOrEqual(0.2);
    expect(c.rate).toBeGreaterThan(8);
    expect(c.rate).toBeLessThan(12);
    expect(c.steps[0]).toMatchObject({ rate: 4 });
    expect(c.unthrottled_ms).toBe(100);
  });

  it("also converges when the throttle overshoots (ratio above the rate's share)", async () => {
    const c = await calibrateRate(sublinear(1.3), { target: 4 });
    expect(c.converged).toBe(true);
    expect(c.rate).toBeLessThan(4);
  });

  it("is accepted at the first step when the rate already does it", async () => {
    const c = await calibrateRate(sublinear(1), { target: 4 });
    expect(c.steps).toHaveLength(1);
    expect(c.rate).toBe(4);
    expect(c.converged).toBe(true);
  });

  it("with noise in the measurements it still ends on the step closest to the target", async () => {
    const c = await calibrateRate(sublinear(0.6, 0.03), { target: 4, tolerance: 0.2 });
    const closest = Math.min(...c.steps.map((s) => Math.abs(s.ratio - 4)));
    expect(Math.abs(c.ratio - 4)).toBeCloseTo(closest, 10);
  });

  it("says it did not converge when no rate can reach the target (the rate is capped)", async () => {
    const c = await calibrateRate(async (rate) => 100 * Math.min(rate, 2), { target: 4, maxSteps: 5 });
    expect(c.converged).toBe(false);
    expect(c.steps.length).toBeLessThanOrEqual(5);
    expect(c.ratio).toBeLessThan(4);
  });

  it("refuses a target that is not a slowdown, and an unthrottled loop that takes no time", async () => {
    await expect(calibrateRate(sublinear(1), { target: 1 })).rejects.toThrow(/target/);
    await expect(calibrateRate(async () => 0, { target: 4 })).rejects.toThrow(/unthrottled/);
  });
});

// A report made of known samples: 24 pages x 3 repetitions, every load of page k takes (10 + k) ms in total.
function fakeInput(overrides: { pages?: number; reps?: number; throttle?: number; bytes?: [number, number] } = {}) {
  const nPages = overrides.pages ?? 24;
  const reps = overrides.reps ?? 3;
  const samples: Sample[] = [];
  for (let rep = 1; rep <= reps; rep++) {
    for (let k = 1; k <= nPages; k++) {
      const total = 10 + k;
      samples.push({ rank: k, snapshot_id: `sha256:${sha(`p${k}`)}`, stratum: "docs", rep, probe_ms: total * 0.6, vectorize_ms: total * 0.3, init_ms: total * 0.02, infer_ms: total * 0.08, total_ms: total, timer_floor_ms: 1, elements: 1500 + k, rows: 1000 + k, score_sum: 1, dom_elements: 1500 + k });
    }
  }
  const [pkg, ext] = overrides.bytes ?? [30_000, 41_000];
  return {
    label: "unit",
    samples,
    pages: Array.from({ length: nPages }, (_, i) => ({ rank: i + 1, snapshot_id: `sha256:${sha(`p${i + 1}`)}`, stratum: "docs", url_key: `https://x${i}.example/`, order_key: sha(`k${i}`), snapshot_nodes: 1500 + i + 1 })),
    selection: { order_prefix: G5_ORDER_PREFIX, element_range: [1500, 3000] as [number, number], requested: 20, eligible: nPages, total: 150, shortfall: false },
    repetitions: reps,
    cpu_throttle: overrides.throttle ?? 4,
    environment: { browser: "158.0.0.0", viewport: [1280, 900] as [number, number], platform: "linux x64", cpus: 8, node: "v24" },
    throttle_check: { unthrottled_ms: 10, throttled_ms: 39, ratio: 3.9 },
    load: { before: [1, 1, 1], after: [2, 2, 2] },
    model: { model_id: `sha256:${sha("m")}`, name: "unit", shape: [59, 64, 32, 1], activation: "sigmoid", sizes: { weights_bytes: 23_812, network_def_bytes: 400, model_json_bytes: pkg - 24_212, golden_bytes: 5000, generated_ts_bytes: ext - 3000, package_bytes: pkg, extension_bytes: ext, full_package_bytes: pkg + 5000, param_count: 5953 } },
    parity: { checked: true, rows: 1000, max_abs_diff: 1e-7, tolerance: 1e-5 },
    params: {},
    warnings: [],
  };
}

describe("the report and how the decision script reads it", () => {
  const doc = buildReport(fakeInput()) as any;

  it("p95 is over all pages x repetitions; the runtime block has what the decision needs", () => {
    // 24 pages x 3 reps = 72 samples: values 11..34, each three times; rank ceil(0.95 * 72) = 69 -> page 11 + 22 = 33
    expect(doc.format).toBe("gran-prix.latency-report");
    expect(doc.intrinsic.runtime).toMatchObject({ p95_ms: 33, p50_ms: 22, model_bytes: 30_000, n_pages: 24, cpu_throttle: 4, repetitions: 3, page_elements: [1501, 1524] });
    expect(doc.intrinsic.runtime.environment).toContain("4x CPU throttle");
    expect(doc.latency_ms.total).toMatchObject({ n: 72, p50: 22, p95: 33, max: 34 });
    expect(Object.keys(doc.latency_ms).sort()).toEqual(["by_repetition", "infer", "init", "per_page_median_p95", "probe", "timer_floor_p50", "total", "vectorize"]);
    expect(doc.latency_ms.by_repetition.map((r: { rep: number }) => r.rep)).toEqual([1, 2, 3]);
    expect(doc.latency_ms.per_page_median_p95).toBe(33);
    expect(doc.per_page).toHaveLength(24);
    expect(doc.size_bytes).toMatchObject({ package_bytes: 30_000, extension_bytes: 41_000, limit: 100_000 });
  });

  it("records how the throttle was obtained: nothing extra for the default, the rate and the search for a calibrated run", () => {
    expect(doc.throttle).toBeNull();
    expect(doc.intrinsic.runtime.throttle_mode).toBeUndefined();
    const cal = { target: 4, tolerance: 0.2, unthrottled_ms: 100, rate: 10.1, ratio: 4.02, converged: true, steps: [{ rate: 4, ratio: 2.3 }, { rate: 10.1, ratio: 4.02 }] };
    const c = buildReport({ ...fakeInput(), throttle: { mode: "calibrated" as const, target: 4, cdp_rate: 10.1, calibration: cal, check_after: { cdp_rate: 10.1, unthrottled_ms: 100, throttled_ms: 405, ratio: 4.05 } } }) as any;
    expect(c.throttle).toMatchObject({ mode: "calibrated", target: 4, cdp_rate: 10.1, calibration: { converged: true, rate: 10.1 }, check_after: { ratio: 4.05 } });
    expect(c.intrinsic.runtime).toMatchObject({ cpu_throttle: 4, throttle_mode: "calibrated", cdp_rate: 10.1 });
    expect(c.intrinsic.runtime.environment).toContain("4x CPU throttle (calibrated CDP rate 10.1)");
    const e = evidenceOf(GO);
    e.g5 = c;
    expect(decide(e, CONFIG).gates.G5).toMatchObject({ passed: true }); // the decision still reads the same fields
  });

  it("the gates carry the numbers and say pass or fail against 150 ms and 100,000 bytes", () => {
    const [lat, size] = doc.gates;
    expect(lat).toMatchObject({ id: "g5_p95_latency", value: 33, passed: true, comparator: "<=", threshold: 150, unit: "ms" });
    expect(size).toMatchObject({ id: "g5_model_size", passed: true, threshold: 100_000, value: 41_000 });
    const slow = buildReport({ ...fakeInput(), samples: fakeInput().samples.map((s) => ({ ...s, total_ms: s.total_ms * 6 })) }) as any;
    expect(slow.gates[0]).toMatchObject({ value: 198, passed: false });
    const big = buildReport(fakeInput({ bytes: [95_000, 110_000] })) as any;
    expect(big.gates[1].passed).toBe(false); // the package fits but the artifact an extension embeds does not
  });

  it("scripts/decide-dom-v0.mjs reads it as the g5 evidence: same p95 and size, gate G5 passes", () => {
    const e = evidenceOf(GO);
    e.g5 = doc;
    const d = decide(e, CONFIG);
    expect(d.gates.G5).toMatchObject({ p95_ms: 33, model_bytes: 30_000, passed: true });
    expect(d.flags.g5_blocks_e4_until_optimized).toBe(false);
    const slow = evidenceOf(GO);
    slow.g5 = buildReport({ ...fakeInput(), samples: fakeInput().samples.map((s) => ({ ...s, total_ms: s.total_ms * 6 })) });
    expect(decide(slow, CONFIG).flags.g5_blocks_e4_until_optimized).toBe(true);
  });

  it("the decision refuses a report with too few pages, repetitions or throttle", () => {
    const few = evidenceOf(GO);
    few.g5 = buildReport(fakeInput({ pages: 5, reps: 1, throttle: 1 }));
    expect(() => decide(few, CONFIG)).toThrow(/pages measured.*cpu_throttle.*repetitions/s);
  });
});

describe("the synthetic model", () => {
  it("[64, 32] over the 59 features of FeatureSchema v0 passes the nine checks and is about 24 KB of weights", () => {
    const dir = tmpDir("gp-lat-synth-");
    writeModelPackage(dir, buildSyntheticModel({ schema: featureSchemaV0 as never, hidden: [64, 32], seed: 7 }));
    const loaded = loadModelPackage(dir, { runtime: "ts" });
    expect(loaded.inputDim).toBe(59);
    expect(loaded.checks).toHaveLength(9);
    loaded.dispose();
    const pm = buildPageModel({ file: (p) => new Uint8Array(readFileSync(join(dir, p))) });
    expect(pm.shape).toEqual([59, 64, 32, 1]);
    expect(pm.sizes.param_count).toBe(59 * 64 + 64 + 64 * 32 + 32 + 32 + 1);
    expect(pm.sizes.weights_bytes).toBe(pm.sizes.param_count * 4);
    expect(pm.sizes.package_bytes).toBeLessThan(100_000);
    expect(pm.sizes.generated_ts_bytes).toBeGreaterThan((pm.sizes.weights_bytes * 4) / 3); // base64 weights cost 4/3, plus the kernels
    expect(pm.moduleBody).not.toMatch(/^export /m);
    expect(pm.moduleBody).toMatch(/return \{ predictLogitsBatch/);
  });

  it("the same seed gives the same bytes; another seed another model", () => {
    const o = { schema: featureSchemaV0 as never, hidden: [8] };
    const a = buildSyntheticModel({ ...o, seed: 1 });
    const b = buildSyntheticModel({ ...o, seed: 1 });
    const c = buildSyntheticModel({ ...o, seed: 2 });
    expect(a["model.json"]).toBe(b["model.json"]);
    expect(a["model.json"]).not.toBe(c["model.json"]);
  });
});

// ---------------------------------------------------------------------------------------------------- the browser
describe("in Chromium, on the synthetic fixture pages (1 repetition, 4x throttle)", () => {
  let modelDir: string;
  let snaps: { file(p: string): Uint8Array };
  let counts: number[];

  beforeAll(() => {
    modelDir = tmpDir("gp-lat-model-");
    writeModelPackage(modelDir, buildSyntheticModel({ schema: featureSchemaV0 as never, hidden: [16, 8], seed: 3 }));
    snaps = { file: (p) => new Uint8Array(readFileSync(join(corpus, "snapshot-set", p))) };
    const r = new SnapshotSetReader(snaps);
    counts = r.entries().map((e) => r.snapshot(e).nodes.length);
  });

  it("measures the pages inside the element range, in hash order, and reports the shape the decision reads", async () => {
    const sorted = [...counts].sort((a, b) => a - b);
    const lo = sorted[1] as number;
    const hi = sorted[sorted.length - 2] as number;
    const inRange = counts.filter((n) => n >= lo && n <= hi).length;
    expect(inRange).toBeLessThan(counts.length); // the range does exclude pages
    const doc = (await measureLatency({ snapshots: snaps, modelDir, pages: 3, repetitions: 1, cpuThrottle: 4, waitFrames: 1, minElements: lo, maxElements: hi, label: "unit-test", log: () => undefined })) as any;

    expect(doc.format).toBe("gran-prix.latency-report");
    expect(doc.label).toBe("unit-test");
    expect(doc.params).toMatchObject({ wait_frames: 1, cpu_throttle: 4, repetitions: 1 });
    expect(doc.selection).toMatchObject({ element_range: [lo, hi], requested: 3, eligible: inRange, total: counts.length, order_prefix: G5_ORDER_PREFIX });
    const reader = new SnapshotSetReader(snaps);
    const expected = selectPages(reader.entries().map((e) => ({ snapshot_id: e.snapshot_id, url: e.url, nodes: reader.snapshot(e).nodes.length })), { minElements: lo, maxElements: hi, count: 3 });
    expect(doc.per_page.map((p: { snapshot_id: string }) => p.snapshot_id)).toEqual(expected.selected.map((p) => p.snapshot_id));
    for (const p of doc.per_page) {
      expect(p.snapshot_nodes).toBeGreaterThanOrEqual(lo);
      expect(p.snapshot_nodes).toBeLessThanOrEqual(hi);
      expect(p.total_ms).toHaveLength(1);
      expect(p.rows).toBeGreaterThan(0);
    }

    const rt = doc.intrinsic.runtime;
    expect(rt.n_pages).toBe(Math.min(3, inRange));
    expect(rt.repetitions).toBe(1);
    expect(rt.cpu_throttle).toBe(4);
    expect(Number.isFinite(rt.p95_ms) && rt.p95_ms > 0).toBe(true);
    expect(rt.model_bytes).toBe(doc.size_bytes.package_bytes);
    expect(rt.page_elements[0]).toBeGreaterThan(0);
    for (const c of ["probe", "vectorize", "init", "infer", "total"]) {
      const s = doc.latency_ms[c];
      expect(s.n).toBe(rt.n_pages);
      expect(s.p95).toBeGreaterThanOrEqual(s.p50);
      expect(s.max).toBeGreaterThanOrEqual(s.p95);
    }
    // the parts are consecutive reads of one clock: they add up to the total
    for (const p of doc.per_page) {
      const parts = p.probe_ms[0] + p.vectorize_ms[0] + p.init_ms[0] + p.infer_ms[0];
      expect(Math.abs(parts - p.total_ms[0])).toBeLessThan(0.1);
    }
    // the in-page scoring is the Node scoring: same rows, same scores
    expect(doc.parity).toMatchObject({ checked: true });
    expect(doc.parity.rows).toBeGreaterThan(0);
    expect(doc.parity.max_abs_diff).toBeLessThanOrEqual(1e-5);
    // The measured throttle factor depends on the machine's load, so only its shape is asserted: it exists, it is a
    // positive finite number, and the report warns exactly when it lands far from the requested rate.
    const check = doc.throttle_check;
    expect(Number.isFinite(check.ratio) && check.ratio > 0).toBe(true);
    expect(Number.isFinite(check.unthrottled_ms) && check.unthrottled_ms > 0).toBe(true);
    expect(Number.isFinite(check.throttled_ms) && check.throttled_ms > 0).toBe(true);
    expect((doc.warnings as string[]).some((w) => /busy-loop check slowed down/.test(w))).toBe(check.ratio < 4 * 0.6);
    expect(doc.environment.browser).toMatch(/^\d+\./);
    expect(doc.load_average.before).toHaveLength(3);
    // too few pages for the gate: the decision script says so
    const e = evidenceOf(GO);
    e.g5 = doc;
    expect(() => decide(e, CONFIG)).toThrow(/pages measured/);
  });

  it("throttle: calibrated searches a CDP rate, measures with it and records the search (shape only, no time asserted)", async () => {
    const doc = (await measureLatency({ snapshots: snaps, modelDir, pages: 1, repetitions: 1, cpuThrottle: 4, throttle: "calibrated", waitFrames: 1, minElements: 1, maxElements: 1e6, verify: false, log: () => undefined })) as any;
    expect(doc.params).toMatchObject({ throttle: "calibrated", cpu_throttle: 4 });
    expect(doc.throttle).toMatchObject({ mode: "calibrated", target: 4 });
    expect(Number.isFinite(doc.throttle.cdp_rate) && doc.throttle.cdp_rate >= 1).toBe(true);
    const cal = doc.throttle.calibration;
    expect(cal.steps.length).toBeGreaterThan(0);
    expect(cal.rate).toBe(doc.throttle.cdp_rate);
    expect(typeof cal.converged).toBe("boolean");
    expect(doc.throttle_check.cdp_rate).toBe(doc.throttle.cdp_rate);
    expect(Number.isFinite(doc.throttle.check_after.ratio)).toBe(true);
    expect(doc.intrinsic.runtime).toMatchObject({ cpu_throttle: 4, throttle_mode: "calibrated", cdp_rate: doc.throttle.cdp_rate });
    // a search that did not converge is said in the warnings, not hidden
    expect((doc.warnings as string[]).some((w) => /calibration did not reach/.test(w))).toBe(!cal.converged);
  });

  it("an unknown throttle mode is refused", async () => {
    await expect(measureLatency({ snapshots: snaps, modelDir, pages: 1, repetitions: 1, throttle: "fast" as never, log: () => undefined })).rejects.toThrow(/throttle must be/);
  });

  it("refuses a browser that is not the pinned one", async () => {
    await expect(measureLatency({ snapshots: snaps, modelDir, pages: 1, repetitions: 1, minElements: 1, maxElements: 1e6, expectBrowser: "1.", log: () => undefined })).rejects.toThrow(/does not match the pin/);
  });

  it("refuses a set with no page in the range", async () => {
    await expect(measureLatency({ snapshots: snaps, modelDir, minElements: 90_000, maxElements: 95_000, log: () => undefined })).rejects.toThrow(/no page of the set/);
  });

  it("runs as a stage of a pipeline: registered, valid, one JSON report out", async () => {
    const plugin = ALL_STAGES.find((s) => s.spec.impl === LATENCY_IMPL);
    expect(plugin?.spec).toMatchObject({ kind: "evaluate", runtime: "node+playwright", determinism: "external" });

    const dir = tmpDir("gp-lat-pipe-");
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const ext = corpusExternals(corpus, dataDir);
    const store = new ArtifactStore(dataPaths(dataDir).artifacts);
    const files: Record<string, Uint8Array | string> = { ...buildSyntheticModel({ schema: featureSchemaV0 as never, hidden: [8], seed: 5 }) };
    const modelId = store.putFiles("ModelPackage", files);
    const spec: PipelineSpec = {
      format: "gran-prix.pipeline-spec",
      format_version: "1.0.0",
      name: "mini-measure-latency",
      externals: { snapshots: ext["snapshots"] as NonNullable<PipelineSpec["externals"]>[string], model: { type: "ModelPackage", id: modelId } },
      stages: [
        {
          id: "latency",
          kind: "evaluate",
          impl: LATENCY_IMPL,
          params: { pages: 2, repetitions: 1, min_elements: 1, max_elements: 1000000, label: "pipeline-test" },
          inputs: { snapshots: { external: "snapshots" }, model: { external: "model" } },
        },
      ],
    };
    const check = checkPipeline(spec, new StageRegistry(ALL_STAGES));
    expect(check.ok ? [] : check.issues).toEqual([]);
    const run = await runPipeline(spec, { dataDir, root: REPO, log: () => undefined });
    expect(run.ok, JSON.stringify(run.stages.map((s) => [s.stageId, s.status, s.error]))).toBe(true);
    const id = run.stages.find((s) => s.stageId === "latency")?.outputs["report"];
    const doc = store.handle(id as `sha256:${string}`, "Bundle").json() as { format: string; label: string; intrinsic: { runtime: { n_pages: number; p95_ms: number } } };
    expect(doc.format).toBe("gran-prix.latency-report");
    expect(doc.label).toBe("pipeline-test");
    expect(doc.intrinsic.runtime.n_pages).toBe(2);
  });
});
