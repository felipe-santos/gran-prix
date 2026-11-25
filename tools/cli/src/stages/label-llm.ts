import { join, resolve } from "node:path";
import { canonicalJson, type NodeLabels } from "@gran-prix/contracts";
import {
  AnthropicTransport,
  DEFAULT_BLOCK_PARAMS,
  DEFAULT_ESTIMATE,
  DEFAULT_ROUTING,
  FsLlmCache,
  NodeFeaturesSetReader,
  SnapshotSetReader,
  assertPrices,
  buildSystemPrompt,
  eligibleUnits,
  labelPagesWithLlm,
  readSetDocs,
  type LlmRequest,
  type LlmResponse,
  type LlmRunConfig,
  type LlmTransport,
  type NodeLabelsDoc,
  type PageJob,
  type PriceTable,
  type SetMember,
} from "@gran-prix/labels";
import { defineStage, type StagePlugin } from "../stage.js";
import type { ArtifactHandle } from "../store.js";

/**
 * `ts:label.llm@1.0.0` (E2.6): the LLM labeler as a stage. Reads the SnapshotSet and NodeFeaturesSet like the
 * other label stages, plus OPTIONAL `layers` (the heuristic / human NodeLabelsSets that drive the routing by
 * disagreement, protocol 5.2), and writes a NodeLabelsSet with `label_source: "llm"` (one document per page) and a
 * `report` (plan, routing, cost) as a Bundle.
 *
 * Money: `determinism: "cached-external"`. Every paid call is reserved from `ctx.ledger` first (the cap defaults to
 * $0, so nothing runs without `--budget-usd`); every response lands in a content-hash cache under
 * `<data dir>/llm-cache/`, so nothing is paid twice, also across different pipelines. `params.dry_run` plans and
 * prints, calls nothing and spends nothing. The API key is read only by `AnthropicTransport`, only from
 * `ANTHROPIC_API_KEY`, only when a call is really needed.
 */

const LABELS_FORMAT = "gran-prix.node-labels";
const labelsPath = (doc: { snapshot_id: string }): string => `labels/${doc.snapshot_id.slice("sha256:".length, "sha256:".length + 12)}.json`;

/** Thrown when the ledger stops the run and `on_budget` is `fail`: the finished work is in the response cache. */
export class LlmBudgetStopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmBudgetStopError";
  }
}

export interface LlmStageDeps {
  /** Provider name that enters the cache key (`anthropic` for the real one). */
  provider: string;
  /** Builds the transport; called only when a paid call is really needed. */
  make(): LlmTransport;
}

const REAL: LlmStageDeps = { provider: "anthropic", make: () => new AnthropicTransport() };

/** Builds the transport on first use, so dry runs and fully cached runs never need a key. */
class LazyTransport implements LlmTransport {
  private inner: LlmTransport | undefined;
  constructor(
    readonly provider: string,
    private readonly make: () => LlmTransport,
  ) {}
  private get t(): LlmTransport {
    return (this.inner ??= this.make());
  }
  assertReady(): void {
    this.t.assertReady?.();
  }
  complete(req: LlmRequest): Promise<LlmResponse> {
    return this.t.complete(req);
  }
}

const num = (p: Readonly<Record<string, unknown>>, k: string, d: number): number => (typeof p[k] === "number" ? (p[k] as number) : d);

export function createLabelLlmStage(deps: LlmStageDeps = REAL): StagePlugin {
  return defineStage(
    {
      kind: "label",
      impl: "ts:label.llm@1.0.0",
      inputs: [
        { name: "snapshots", type: "SnapshotSet" },
        { name: "features", type: "NodeFeaturesSet" },
        { name: "layers", type: "NodeLabelsSet", many: true, optional: true },
      ],
      outputs: [
        { name: "labels", type: "NodeLabelsSet" },
        { name: "report", type: "Bundle", optional: true },
      ],
      params_schema: {
        type: "object",
        required: ["model", "prices", "guide_path", "guide_sha256"],
        properties: {
          model: { type: "string", minLength: 1, description: "Exact model id, frozen with the prompt (protocol 13). Required: there is no default." },
          prices: {
            type: "object",
            required: ["input_usd_per_mtok", "output_usd_per_mtok"],
            properties: {
              input_usd_per_mtok: { type: "number", minimum: 0 },
              output_usd_per_mtok: { type: "number", minimum: 0 },
              cache_write_usd_per_mtok: { type: "number", minimum: 0 },
              cache_read_usd_per_mtok: { type: "number", minimum: 0 },
            },
            additionalProperties: false,
            description: "USD per million tokens, checked on the day of the run (protocol 5.6). No default.",
          },
          guide_path: { type: "string", minLength: 1, description: "The frozen guia-de-anotacao.md (resolved against the run root); sections 1-4 become the system prompt." },
          guide_sha256: { type: "string", pattern: "^(sha256:)?[0-9a-f]{64}$", description: "Pinned sha256 of the whole guide file (prereg-dom-v0.txt); a mismatch aborts." },
          prompt_id: { type: "string", minLength: 1, description: "Label of the prompt version (default dom-v0-llm-labeler@1)." },
          dry_run: { type: "boolean", description: "Plan and print (pages, blocks, tokens, cost, cache hits); call nothing, spend nothing." },
          routing: {
            type: "object",
            properties: {
              mode: { enum: ["disagreement", "all"] },
              control_sample: { type: "number", minimum: 0, maximum: 1 },
              seed: { type: "string" },
              abstain_page_frac: { type: "number", minimum: 0, maximum: 1 },
            },
            additionalProperties: false,
          },
          include_url_contains: { type: "array", items: { type: "string", minLength: 1 }, description: "Only pages whose url contains one of these strings." },
          max_pages: { type: "integer", minimum: 1, description: "At most this many pages (after include_url_contains), in set order." },
          chunk_blocks: { type: "integer", minimum: 1, description: "Blocks to label per request (protocol: 400)." },
          ctx_blocks: { type: "integer", minimum: 0, description: "Read-only context blocks before each chunk (protocol: 10)." },
          block_chars: { type: "integer", minimum: 1, description: "Characters of text per block (protocol: 200)." },
          path_depth: { type: "integer", minimum: 1, description: "Ancestor tags in the block path (default 3)." },
          confidence: { type: "number", minimum: 0, maximum: 1, description: "P(label correct) of a decided block (default 0.8, to be calibrated on the audit); doubt is always 0.5." },
          send_temperature: { type: "boolean", description: "Send temperature 0 (default true). false for models that reject sampling parameters; recorded in the labels." },
          on_missing: { enum: ["fail_page", "leave_unlabeled"], description: "Ids still missing after the one retry: leave them unlabeled (default; pre-registered protocol 5.3) or fail the whole page." },
          on_budget: { enum: ["fail", "partial"], description: "When the ledger stops the run: fail the stage (default; finished work stays in the cache) or return the finished pages." },
          retry_failed: { type: "boolean", description: "Pay again for chunks whose cached outcome is a failure." },
          private_categories: { type: "array", items: { type: "string" }, description: "Page categories never sent to a cloud LLM (default [logged_in])." },
          chars_per_token: { type: "number", exclusiveMinimum: 0 },
          safety_factor: { type: "number", minimum: 1 },
          output_tokens_per_block: { type: "integer", minimum: 1 },
          output_overhead_tokens: { type: "integer", minimum: 0 },
          max_output_tokens: { type: "integer", minimum: 1 },
          expected_output_tokens_per_block: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      runtime: "node",
      determinism: "cached-external",
    },
    async (ctx) => {
      const p = ctx.params;
      const prices = p["prices"] as PriceTable;
      assertPrices(prices);
      const system = buildSystemPrompt(resolve(ctx.root, p["guide_path"] as string), p["guide_sha256"] as string, typeof p["prompt_id"] === "string" ? p["prompt_id"] : undefined);
      const routingIn = (p["routing"] ?? {}) as Partial<typeof DEFAULT_ROUTING>;
      const cfg: LlmRunConfig = {
        provider: deps.provider,
        model: p["model"] as string,
        prices,
        system: { ...system, prompt_id: `${system.prompt_id}+guide-${system.guide_sha256.slice(0, 12)}` },
        send_temperature: p["send_temperature"] !== false,
        output_tokens_per_block: num(p, "output_tokens_per_block", 24),
        output_overhead_tokens: num(p, "output_overhead_tokens", 512),
        max_output_tokens: num(p, "max_output_tokens", 16000),
        expected_output_tokens_per_block: num(p, "expected_output_tokens_per_block", 20),
        estimate: { chars_per_token: num(p, "chars_per_token", DEFAULT_ESTIMATE.chars_per_token), safety_factor: num(p, "safety_factor", DEFAULT_ESTIMATE.safety_factor) },
        on_missing: p["on_missing"] === "fail_page" ? "fail_page" : "leave_unlabeled",
        retry_failed: p["retry_failed"] === true,
        chunk_blocks: num(p, "chunk_blocks", 400),
        ctx_blocks: num(p, "ctx_blocks", 10),
        block_chars: num(p, "block_chars", DEFAULT_BLOCK_PARAMS.block_chars),
        path_depth: num(p, "path_depth", DEFAULT_BLOCK_PARAMS.path_depth),
        confidence: num(p, "confidence", 0.8),
        routing: { ...DEFAULT_ROUTING, ...routingIn },
        private_categories: Array.isArray(p["private_categories"]) ? (p["private_categories"] as string[]) : ["logged_in"],
        dry_run: p["dry_run"] === true,
        on_budget: p["on_budget"] === "partial" ? "partial" : "fail",
      };
      if (cfg.chunk_blocks * cfg.output_tokens_per_block + cfg.output_overhead_tokens > cfg.max_output_tokens) {
        throw new Error("chunk_blocks x output_tokens_per_block + overhead exceeds max_output_tokens: a full chunk could not be answered");
      }

      const snaps = new SnapshotSetReader(ctx.inputs["snapshots"] as ArtifactHandle);
      const feats = new NodeFeaturesSetReader(ctx.inputs["features"] as ArtifactHandle);
      const entries = new Map(snaps.entries().map((e) => [e.snapshot_id, e]));
      const layersBySnapshot = new Map<string, NodeLabels[]>();
      for (const layer of (ctx.inputs["layers"] ?? []) as ArtifactHandle[]) {
        for (const m of readSetDocs<NodeLabels>(layer, LABELS_FORMAT) as SetMember<NodeLabels>[]) {
          const list = layersBySnapshot.get(m.doc.snapshot_id);
          if (list) list.push(m.doc);
          else layersBySnapshot.set(m.doc.snapshot_id, [m.doc]);
        }
      }
      const featureEntries = feats.entries();
      if (featureEntries.length === 0) throw new Error("the features set holds no NodeFeatures document");
      const include = Array.isArray(p["include_url_contains"]) ? (p["include_url_contains"] as string[]) : undefined;
      let jobs: PageJob[] = featureEntries.map((fe) => {
        const se = entries.get(fe.snapshot_id);
        if (!se) throw new Error(`features ${fe.features_id} refer to snapshot ${fe.snapshot_id}, which is not in the snapshot set`);
        const snapshot = snaps.snapshot(se);
        return { name: snapshot.page.url_key, snapshot, units: eligibleUnits(snapshot, feats.features(fe)), layers: layersBySnapshot.get(fe.snapshot_id) ?? [] };
      });
      if (include) jobs = jobs.filter((j) => include.some((s) => j.snapshot.page.url.includes(s) || j.snapshot.page.final_url.includes(s)));
      if (typeof p["max_pages"] === "number") jobs = jobs.slice(0, p["max_pages"]);

      const result = await labelPagesWithLlm(jobs, cfg, {
        transport: new LazyTransport(deps.provider, deps.make),
        ledger: ctx.ledger,
        cache: new FsLlmCache(join(ctx.dataDir, "llm-cache")),
        log: ctx.log,
      });
      const t = result.report.totals;
      ctx.log(
        `${cfg.dry_run ? "DRY RUN (nothing spent): " : ""}${t.pages} page(s), ${t.routed_blocks} block(s) routed, ${t.chunks} chunk(s), ${t.cache_hits} cache hit(s), ${t.calls} call(s); ` +
          (cfg.dry_run
            ? `~${t.est_input_tokens} input / ~${t.est_output_tokens} output tokens, estimated $${t.est_expected_usd.toFixed(4)} (worst case $${t.est_worst_usd.toFixed(4)}) at the given prices`
            : `spent $${t.spent_usd.toFixed(4)}`),
      );
      if (result.budgetStop && cfg.on_budget === "fail") {
        throw new LlmBudgetStopError(
          `stopped at ${result.budgetStop.page}: ${result.budgetStop.message}. ${result.docs.length} page(s) finished and every paid response is cached under ${join(ctx.dataDir, "llm-cache")}: re-run with a larger --budget-usd to resume without paying twice`,
        );
      }
      const files: Record<string, string> = {};
      for (const d of result.docs as NodeLabelsDoc[]) files[labelsPath(d)] = `${canonicalJson(d)}\n`;
      return { labels: { files }, report: { json: result.report } };
    },
  );
}

export const labelLlm: StagePlugin = createLabelLlmStage();
export const LLM_LABEL_STAGES: readonly StagePlugin[] = [labelLlm];
