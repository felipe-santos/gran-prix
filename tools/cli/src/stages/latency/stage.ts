import { join } from "node:path";
import { canonicalJson } from "@gran-prix/contracts";
import { defineStage, type StageContext, type StageOutputs, type StagePlugin } from "../../stage.js";
import type { ArtifactHandle } from "../../store.js";
import { measureLatency } from "./measure.js";
import { G5_MAX_ELEMENTS, G5_MIN_ELEMENTS, G5_MIN_PAGES, G5_ORDER_PREFIX } from "./select.js";

/**
 * `ts:measure.latency@1.0.0` (G5, protocol section 8): the cost of running the model on a page.
 *
 * Takes the frozen SnapshotSet and a ModelPackage. Picks the pages with 1,500 to 3,000 elements in the order of
 * `sha256("gp-dom-v0|20261125|g5|" + url)` (the first 20), and for each of them, 3 times, loads the flattened html in
 * the pinned headless Chromium with the CPU throttled 4x (CDP), injects the features bundle and the generated model
 * module, and times probe, vectorize, model init and inference inside the page. The `report` output carries the p95 of
 * the total, the package size and the gate in the shape `scripts/decide-dom-v0.mjs` reads (`intrinsic.runtime`). What
 * enters each number is written in the report's `protocol` block.
 *
 * `determinism: "external"`: the output is a measurement of the machine, so two runs differ in the digits.
 * The snapshots are static, scriptless html; the real G5 is measured in the extension by E4.
 */

export const LATENCY_IMPL = "ts:measure.latency@1.0.0";

interface Params {
  pages?: number;
  repetitions?: number;
  cpu_throttle?: number;
  throttle?: "cdp-rate" | "calibrated";
  min_elements?: number;
  max_elements?: number;
  order_prefix?: string;
  viewport?: [number, number];
  stamp?: boolean;
  wait_frames?: number;
  verify?: boolean;
  label?: string;
  expect_browser?: string;
}

const PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pages: { type: "integer", minimum: 1, description: `Pages to measure (default ${G5_MIN_PAGES}; the gate asks for at least ${G5_MIN_PAGES}).` },
    repetitions: { type: "integer", minimum: 1, description: "Timed loads per page (default 3; every one counts)." },
    cpu_throttle: { type: "number", minimum: 1, description: "The CPU slowdown to measure under (default 4). With throttle \"cdp-rate\" it is the CDP Emulation.setCPUThrottlingRate rate." },
    throttle: { type: "string", enum: ["cdp-rate", "calibrated"], description: "\"cdp-rate\" (default): set the CDP rate to cpu_throttle (its effect on a ~100 ms task is well under the rate). \"calibrated\": search the CDP rate that makes a ~100 ms reference loop cpu_throttle times slower (within 0.2) and measure with it; the rate and the search are in the report." },
    min_elements: { type: "integer", minimum: 0, description: `Smallest page, in elements of the snapshot (default ${G5_MIN_ELEMENTS}).` },
    max_elements: { type: "integer", minimum: 0, description: `Largest page, in elements of the snapshot (default ${G5_MAX_ELEMENTS}).` },
    order_prefix: { type: "string", minLength: 1, description: `Prefix of the page order, sha256(prefix + url) (default "${G5_ORDER_PREFIX}").` },
    viewport: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 2, maxItems: 2, description: "[width, height] (default [1280, 900])." },
    stamp: { type: "boolean", description: "Write data-gp-id like the collector's probe (default true; an upper bound for the extension)." },
    wait_frames: { type: "integer", minimum: 0, description: "Frames rendered before the clock starts (default 2: style and layout clean, as after the real settle wait; 0 puts the page's first layout inside the probe)." },
    verify: { type: "boolean", description: "Compare the in-page scores of one load with @gran-prix/model in Node (default true)." },
    label: { type: "string", description: 'What this run is, recorded in the report (default "descriptive").' },
    expect_browser: { type: "string", minLength: 1, description: "Pin: fail unless the Chromium version starts with this string." },
  },
} as const;

export const measureLatencyStage: StagePlugin = defineStage(
  {
    kind: "evaluate",
    impl: LATENCY_IMPL,
    inputs: [
      { name: "snapshots", type: "SnapshotSet" },
      { name: "model", type: "ModelPackage" },
    ],
    outputs: [{ name: "report", type: "Bundle" }],
    params_schema: PARAMS_SCHEMA,
    runtime: "node+playwright",
    determinism: "external",
  },
  async (ctx: StageContext): Promise<StageOutputs> => {
    const p = ctx.params as Params;
    const snapshots = ctx.inputs["snapshots"] as ArtifactHandle;
    const model = ctx.inputs["model"] as ArtifactHandle;
    const doc = await measureLatency({
      snapshots,
      modelDir: join(model.dir, "files"),
      ...(p.pages !== undefined ? { pages: p.pages } : {}),
      ...(p.repetitions !== undefined ? { repetitions: p.repetitions } : {}),
      ...(p.cpu_throttle !== undefined ? { cpuThrottle: p.cpu_throttle } : {}),
      ...(p.throttle !== undefined ? { throttle: p.throttle } : {}),
      ...(p.min_elements !== undefined ? { minElements: p.min_elements } : {}),
      ...(p.max_elements !== undefined ? { maxElements: p.max_elements } : {}),
      ...(p.order_prefix !== undefined ? { orderPrefix: p.order_prefix } : {}),
      ...(p.viewport !== undefined ? { viewport: { width: p.viewport[0], height: p.viewport[1] } } : {}),
      ...(p.stamp !== undefined ? { stamp: p.stamp } : {}),
      ...(p.wait_frames !== undefined ? { waitFrames: p.wait_frames } : {}),
      ...(p.verify !== undefined ? { verify: p.verify } : {}),
      ...(p.label !== undefined ? { label: p.label } : {}),
      ...(p.expect_browser !== undefined ? { expectBrowser: p.expect_browser } : {}),
      log: (m) => ctx.log(m),
    });
    return { report: { json: JSON.parse(canonicalJson(doc)) as unknown } };
  },
);

export const LATENCY_STAGES: readonly StagePlugin[] = [measureLatencyStage];
