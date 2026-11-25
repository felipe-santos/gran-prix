import { defineStage, type StagePlugin } from "../stage.js";

/**
 * Demo / test stages. They exercise the runner (typed ports, params schema,
 * caching, failure handling, the ledger) without touching real data. Real
 * stages (collect, extract, label, dataset, train, evaluate, package) arrive
 * in wave 3. Port types are the contract's artifact types; `Bundle` carries
 * any JSON here, and the stage kinds are borrowed from the closed kind list.
 */

const BUNDLE = "Bundle" as const;

/** `ts:demo.emit-json@1.0.0`: emits `{ value: params.value }`. */
export const emitJson = defineStage(
  {
    kind: "collect",
    impl: "ts:demo.emit-json@1.0.0",
    inputs: [],
    outputs: [{ name: "out", type: BUNDLE }],
    params_schema: { type: "object", required: ["value"], properties: { value: {} }, additionalProperties: false },
    runtime: "node",
    determinism: "pure",
  },
  (ctx) => ({ out: { json: { value: ctx.params["value"] } } }),
);

/** `ts:demo.emit-files@1.0.0`: emits a file-set artifact (`params.files`: path -> text). */
export const emitFiles = defineStage(
  {
    kind: "dataset",
    impl: "ts:demo.emit-files@1.0.0",
    inputs: [],
    outputs: [{ name: "out", type: BUNDLE }],
    params_schema: {
      type: "object",
      required: ["files"],
      properties: { files: { type: "object", additionalProperties: { type: "string" } } },
      additionalProperties: false,
    },
    runtime: "node",
    determinism: "pure",
  },
  (ctx) => ({ out: { files: ctx.params["files"] as Record<string, string> } }),
);

/** `ts:demo.concat@1.0.0`: joins the `value` of every part with `params.separator`. */
export const concat = defineStage(
  {
    kind: "extract",
    impl: "ts:demo.concat@1.0.0",
    inputs: [{ name: "parts", type: BUNDLE, many: true }],
    outputs: [{ name: "out", type: BUNDLE }],
    params_schema: { type: "object", properties: { separator: { type: "string" } }, additionalProperties: false },
    runtime: "node",
    determinism: "pure",
  },
  (ctx) => {
    const parts = ctx.inputs["parts"] as Array<{ json(): unknown }>;
    const sep = typeof ctx.params["separator"] === "string" ? ctx.params["separator"] : "";
    const values = parts.map((p) => String((p.json() as { value: unknown }).value));
    return { out: { json: { value: values.join(sep), n: values.length } } };
  },
);

/** `ts:demo.fail@1.0.0`: throws unless `params.fail` is false (then it passes `in` through). */
export const failStage = defineStage(
  {
    kind: "evaluate",
    impl: "ts:demo.fail@1.0.0",
    inputs: [{ name: "in", type: BUNDLE, optional: true }],
    outputs: [{ name: "out", type: BUNDLE }],
    params_schema: {
      type: "object",
      properties: { message: { type: "string" }, fail: { type: "boolean" } },
      additionalProperties: false,
    },
    runtime: "node",
    determinism: "pure",
  },
  (ctx) => {
    if (ctx.params["fail"] === false) {
      const input = ctx.inputs["in"] as { json(): unknown } | undefined;
      return { out: { json: input ? input.json() : { value: null } } };
    }
    throw new Error(typeof ctx.params["message"] === "string" ? ctx.params["message"] : "demo.fail: failing on purpose");
  },
);

/**
 * `ts:demo.spend@1.0.0`: pretends to make `params.calls` paid calls of
 * `params.cost_usd` each, reserving every one from the ledger first. A cache
 * hit never calls it, so re-running an unchanged pipeline spends nothing.
 */
export const spend = defineStage(
  {
    kind: "label",
    impl: "ts:demo.spend@1.0.0",
    inputs: [{ name: "in", type: BUNDLE }],
    outputs: [{ name: "out", type: BUNDLE }],
    params_schema: {
      type: "object",
      required: ["cost_usd"],
      properties: { cost_usd: { type: "number", minimum: 0 }, calls: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    },
    runtime: "node",
    determinism: "cached-external",
  },
  (ctx) => {
    const cost = ctx.params["cost_usd"] as number;
    const calls = typeof ctx.params["calls"] === "number" ? ctx.params["calls"] : 1;
    let total = 0;
    for (let i = 0; i < calls; i++) {
      const r = ctx.ledger.reserve(cost, `demo call ${i + 1}/${calls}`);
      r.commit();
      total += cost;
    }
    const input = (ctx.inputs["in"] as { json(): unknown }).json();
    return { out: { json: { from: input, calls, spent_usd: total } } };
  },
);

export const DEMO_STAGES: readonly StagePlugin[] = [emitJson, emitFiles, concat, failStage, spend];
