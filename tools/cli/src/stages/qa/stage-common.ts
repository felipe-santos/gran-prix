import { artifactId, stageCacheKey, type EvalReport, type Sha256 } from "@gran-prix/contracts";
import { assertPrices, type PriceTable } from "@gran-prix/labels";
import type { StageContext } from "../../stage.js";
import type { ArtifactHandle } from "../../store.js";
import { GP_VERSION } from "../../version.js";
import { CAPABILITIES_SCHEMA, PARAMS_PROPERTIES, resolveParams, type ModelCaps, type ResolvedParams } from "./model-params.js";
import { LazyQaTransport, QaAnthropicTransport, type QaTransport } from "./transport.js";
import type { CallModel } from "./call.js";

/** Pieces the QA stages share: transport injection, model parameter blocks, provenance, input access. */

export interface QaStageDeps {
  /** Provider name that enters the cache key (`anthropic` for the real one). */
  provider: string;
  /** Builds the transport; called only when a paid call is really needed. */
  make(): QaTransport;
}

export const REAL_DEPS: QaStageDeps = { provider: "anthropic", make: () => new QaAnthropicTransport() };

export const lazyTransport = (deps: QaStageDeps): QaTransport => new LazyQaTransport(deps.provider, deps.make);

/** `{ model, prices, send_temperature?, thinking?, effort? }` as a JSON-schema fragment (generator, respondent, judge). */
export const modelBlock = (what: string): Record<string, unknown> => ({
  type: "object",
  required: ["model", "prices"],
  additionalProperties: false,
  description: what,
  properties: {
    model: { type: "string", minLength: 1, description: "Exact model id, frozen before the first call (protocol 13). Required: there is no default." },
    prices: {
      type: "object",
      required: ["input_usd_per_mtok", "output_usd_per_mtok"],
      additionalProperties: false,
      properties: {
        input_usd_per_mtok: { type: "number", minimum: 0 },
        output_usd_per_mtok: { type: "number", minimum: 0 },
        cache_write_usd_per_mtok: { type: "number", minimum: 0 },
        cache_read_usd_per_mtok: { type: "number", minimum: 0 },
      },
      description: "USD per million tokens, checked on the day of the run (protocol 5.6). No default.",
    },
    ...PARAMS_PROPERTIES,
  },
});

export { CAPABILITIES_SCHEMA };

export interface ModelBlock {
  model: string;
  prices: PriceTable;
  send_temperature?: boolean;
  thinking?: "off" | "adaptive";
  effort?: string;
}

/** Validates a model block against the capability table and returns what a call needs. Throws before anything is called. */
export function callModel(provider: string, b: ModelBlock, caps?: Readonly<Record<string, ModelCaps>>): CallModel {
  assertPrices(b.prices);
  const params: ResolvedParams = resolveParams(b.model, { ...(b.send_temperature !== undefined ? { send_temperature: b.send_temperature } : {}), ...(b.thinking !== undefined ? { thinking: b.thinking } : {}), ...(b.effort !== undefined ? { effort: b.effort } : {}) }, caps);
  return { provider, model: b.model, prices: b.prices, params };
}

export const single = (ctx: StageContext, port: string): ArtifactHandle => {
  const h = ctx.inputs[port];
  if (h === undefined || Array.isArray(h)) throw new Error(`input "${port}" is missing`);
  return h;
};

export const optionalSingle = (ctx: StageContext, port: string): ArtifactHandle | undefined => {
  const h = ctx.inputs[port];
  return h === undefined || Array.isArray(h) ? undefined : h;
};

const ZERO_SHA: Sha256 = `sha256:${"0".repeat(64)}`;
export { ZERO_SHA };

/** Deterministic embedded provenance (the runner's receipts hold the real one), like `evaluate.intrinsic`. */
export function provenance(ctx: StageContext): EvalReport["provenance"] {
  const inputIds = Object.fromEntries(Object.entries(ctx.inputs).map(([port, h]) => [port, Array.isArray(h) ? h.map((x) => x.id) : h.id])) as Record<string, Sha256 | Sha256[]>;
  const flat = Object.entries(inputIds).flatMap(([port, v]) => (Array.isArray(v) ? v.map((id) => ({ port, artifact_id: id })) : [{ port, artifact_id: v }]));
  return {
    produced_by: {
      run_id: "deterministic",
      stage_id: ctx.stageId,
      kind: ctx.kind,
      impl: ctx.impl,
      params_sha256: artifactId(ctx.params),
      cache_key: stageCacheKey({ impl: ctx.impl, kind: ctx.kind, params: ctx.params, inputIds }),
    },
    inputs: flat,
    pipeline_spec_id: ZERO_SHA,
    tool_versions: { gp_cli: GP_VERSION, node: process.version },
    created_at: "1970-01-01T00:00:00Z",
    duration_ms: 0,
  };
}

/** Thrown when the ledger stops a stage and `on_budget` is `fail`: the finished work is in the response cache. */
export class QaBudgetStopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaBudgetStopError";
  }
}

export const num = (p: Readonly<Record<string, unknown>>, k: string, d: number): number => (typeof p[k] === "number" ? (p[k] as number) : d);

/** `<data dir>/qa-cache`: the content-hash cache of the QA calls (separate from the labeler's `llm-cache`). */
export const QA_CACHE_DIR = "qa-cache";
