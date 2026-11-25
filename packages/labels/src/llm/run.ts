import { THREE_CLASS_SPACE, type NodeLabelItem, type NodeLabels, type PageSnapshot } from "@gran-prix/contracts";
import { buildBlocks, chunkBlocks, type BlockParams } from "./blocks.js";
import type { LlmResponseCache } from "./cache.js";
import { isCacheHit, planChunk, runChunk, OUTPUT_CONTRACT, type CallConfig, type ChunkPlan } from "./chunk-call.js";
import { usageCostUSD } from "./cost.js";
import { buildNodeLabels, type NodeLabelsDoc } from "../node-labels.js";
import { routePage, votersFromLabels, type RoutingParams } from "./routing.js";
import { LlmTransportError, isBudgetError, type LlmLedgerPort, type LlmTransport, type LlmUsage } from "./types.js";

/** `labeler.id` of the documents this module writes. */
export const LLM_LABELER_ID = "llm-blocks@1.0.0";
export const LLM_REPORT_FORMAT = "gran-prix.llm-label-report" as const;

export interface LlmRunConfig extends CallConfig, BlockParams {
  chunk_blocks: number;
  ctx_blocks: number;
  /** P(label correct) stamped on a decided block. Doubt (`u`) is always 0.5 (protocol). */
  confidence: number;
  routing: RoutingParams;
  /** Categories whose text never goes to a cloud LLM (protocol 2.5: logged-in pages). */
  private_categories: readonly string[];
  dry_run: boolean;
  /** `fail`: the stage throws when the ledger refuses a reservation (the work done stays in the cache). `partial`: it returns what it finished. */
  on_budget: "fail" | "partial";
}

/** One page to label. `units` = the units a labeler may be asked about (elements that own text). */
export interface PageJob {
  name: string;
  snapshot: PageSnapshot;
  units: readonly number[];
  /** Label layers of this snapshot (heuristic voters, human layers) used for routing. */
  layers: readonly NodeLabels[];
}

export interface LlmRuntime {
  transport?: LlmTransport;
  ledger?: LlmLedgerPort;
  cache: LlmResponseCache;
  log?: (message: string) => void;
}

export type PageStatus = "ok" | "failed" | "dry_run" | "skipped_private" | "budget_stopped" | "not_run";

export interface PageReport {
  name: string;
  snapshot_id: string;
  category: string;
  status: PageStatus;
  error?: string;
  routing: { mode: string; page_whole: string | null; counts: Record<string, unknown>; routed_sha256: string };
  routed_unit_ids: number[];
  chunks: number;
  cache_hits: number;
  calls: number;
  est_input_tokens: number;
  est_output_tokens: number;
  est_worst_usd: number;
  est_expected_usd: number;
  spent_usd: number;
}

export interface LlmReport {
  format: typeof LLM_REPORT_FORMAT;
  format_version: "1.0.0";
  dry_run: boolean;
  provider: string;
  model: string;
  prompt_id: string;
  prompt_sha256: string;
  guide_sha256: string;
  prices_usd_per_mtok: CallConfig["prices"];
  budget_stop: { page: string; message: string } | null;
  totals: {
    pages: number;
    by_status: Record<string, number>;
    routed_blocks: number;
    chunks: number;
    cache_hits: number;
    calls: number;
    /** Estimates cover only chunks that are NOT cache hits (what a run would still pay for). */
    est_input_tokens: number;
    est_output_tokens: number;
    est_worst_usd: number;
    est_expected_usd: number;
    spent_usd: number;
  };
  pages: PageReport[];
}

export interface LlmRunResult {
  /** One labels document per page that was processed (including failed / dry-run / skipped ones). */
  docs: NodeLabelsDoc[];
  report: LlmReport;
  budgetStop: { page: string; message: string } | null;
}

const CLASSES = THREE_CLASS_SPACE.classes;
const CLASS_OF = { M: CLASSES.indexOf("main"), S: CLASSES.indexOf("support"), N: CLASSES.indexOf("noise") } as const;
const sumUsage = (list: readonly LlmUsage[]): LlmUsage =>
  list.reduce(
    (a, b) => ({
      input_tokens: a.input_tokens + b.input_tokens,
      output_tokens: a.output_tokens + b.output_tokens,
      cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
      cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    }),
    { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  );

/** Everything that determines what the labeler writes (and nothing volatile): hashed into `params_sha256`. */
function labelerParams(cfg: LlmRunConfig): Record<string, unknown> {
  return {
    provider: cfg.provider,
    model: cfg.model,
    prompt_id: cfg.system.prompt_id,
    prompt_sha256: cfg.system.prompt_sha256,
    guide_sha256: cfg.system.guide_sha256,
    output_contract: OUTPUT_CONTRACT,
    temperature_sent: cfg.send_temperature,
    chunk_blocks: cfg.chunk_blocks,
    ctx_blocks: cfg.ctx_blocks,
    block_chars: cfg.block_chars,
    path_depth: cfg.path_depth,
    confidence: cfg.confidence,
    on_missing: cfg.on_missing,
    output_tokens_per_block: cfg.output_tokens_per_block,
    output_overhead_tokens: cfg.output_overhead_tokens,
    max_output_tokens: cfg.max_output_tokens,
  };
}

interface Built {
  doc: NodeLabelsDoc;
}

function buildDoc(
  job: PageJob,
  cfg: LlmRunConfig,
  status: PageStatus,
  items: NodeLabelItem[],
  keys: string[],
  usage: LlmUsage,
  extra: Record<string, unknown>,
): Built {
  const doc = buildNodeLabels({
    snapshot_id: job.snapshot.snapshot_id,
    labeler: {
      id: LLM_LABELER_ID,
      kind: "llm",
      params: labelerParams(cfg),
      llm: {
        model: cfg.model,
        prompt_id: cfg.system.prompt_id,
        prompt_sha256: cfg.system.prompt_sha256,
        temperature: 0,
        response_cache_keys: [...new Set(keys)].sort() as `sha256:${string}`[],
      },
    },
    items,
    n_candidates: job.units.length,
    extra: {
      llm_run: {
        status,
        guide_sha256: cfg.system.guide_sha256,
        guide_sections_sha256: cfg.system.sections_sha256,
        temperature_sent: cfg.send_temperature,
        usage,
        cost_usd_at_prices: usageCostUSD(usage, cfg.prices),
        ...extra,
      },
    },
  });
  return { doc };
}

/**
 * Labels pages with the LLM, one chunk at a time, in page order.
 *
 * Cost control: a cache hit never reaches the transport or the ledger; every other call is reserved first
 * (see `runChunk`); the first refusal of the ledger stops the run cleanly: pages finished so far are returned
 * (and every paid response is already in the cache). `dry_run` plans everything and touches neither.
 */
export async function labelPagesWithLlm(pages: readonly PageJob[], cfg: LlmRunConfig, rt: LlmRuntime): Promise<LlmRunResult> {
  const docs: NodeLabelsDoc[] = [];
  const reports: PageReport[] = [];
  let budgetStop: LlmRunResult["budgetStop"] = null;

  for (const job of pages) {
    const snap = job.snapshot;
    const category = snap.page.category;
    const base = { name: job.name, snapshot_id: snap.snapshot_id, category };
    const { voters, settled } = votersFromLabels(job.layers);
    const decision = routePage(snap.snapshot_id, job.units, voters, settled, cfg.routing);
    const routingRec = { mode: decision.mode, page_whole: decision.page_whole, counts: decision.counts as unknown as Record<string, unknown>, routed_sha256: decision.routed_sha256 };
    const empty = { chunks: 0, cache_hits: 0, calls: 0, est_input_tokens: 0, est_output_tokens: 0, est_worst_usd: 0, est_expected_usd: 0, spent_usd: 0 };
    const routedIds = [...decision.routed.keys()];

    if (budgetStop) {
      reports.push({ ...base, status: "not_run", routing: routingRec, routed_unit_ids: routedIds, ...empty });
      continue;
    }
    if (cfg.private_categories.includes(category)) {
      const { doc } = buildDoc(job, cfg, "skipped_private", [], [], sumUsage([]), { routing: routingRec, reason: `category ${category} never goes to a cloud LLM` });
      docs.push(doc);
      reports.push({ ...base, status: "skipped_private", routing: routingRec, routed_unit_ids: [], ...empty });
      continue;
    }

    const blocks = buildBlocks(snap, job.units, cfg);
    const header = { title: snap.page.title ?? "", category };
    const plans: ChunkPlan[] = chunkBlocks(blocks, new Set(decision.routed.keys()), cfg.chunk_blocks, cfg.ctx_blocks).map((c) =>
      planChunk(header, c, cfg, rt.cache),
    );
    const pending = plans.filter((p) => !isCacheHit(p, cfg));
    const est = {
      chunks: plans.length,
      cache_hits: plans.length - pending.length,
      est_input_tokens: pending.reduce((n, p) => n + p.est.input_tokens, 0),
      est_output_tokens: pending.reduce((n, p) => n + Math.min(p.maxTokens, p.chunk.labeled.length * cfg.expected_output_tokens_per_block), 0),
      est_worst_usd: pending.reduce((n, p) => n + p.est.worst_usd, 0),
      est_expected_usd: pending.reduce((n, p) => n + p.est.expected_usd, 0),
    };

    if (cfg.dry_run) {
      const { doc } = buildDoc(job, cfg, "dry_run", [], [], sumUsage([]), { routing: routingRec });
      docs.push(doc);
      rt.log?.(
        `${job.name}: ${decision.routed.size}/${job.units.length} blocks routed (${decision.mode === "all" ? "mode all" : decision.page_whole ? `whole page: ${decision.page_whole}` : "by disagreement"}), ${plans.length} chunk(s), ${est.cache_hits} cache hit(s), ~${est.est_input_tokens} in / ~${est.est_output_tokens} out tokens, est $${est.est_expected_usd.toFixed(4)} (worst $${est.est_worst_usd.toFixed(4)})`,
      );
      reports.push({ ...base, status: "dry_run", routing: routingRec, routed_unit_ids: routedIds, ...est, calls: 0, spent_usd: 0 });
      continue;
    }

    const items: NodeLabelItem[] = [];
    const keys: string[] = [];
    const usages: LlmUsage[] = [];
    let calls = 0;
    let hits = 0;
    let spent = 0;
    let status: PageStatus = "ok";
    let error: string | undefined;
    let missing = 0;
    const byId = new Map(blocks.map((b) => [b.id, b]));

    try {
      for (const plan of plans) {
        const out = await runChunk(plan, cfg, rt);
        calls += out.calls;
        spent += out.spent_usd;
        if (out.hit) hits++;
        if (out.record.status !== "ok") {
          status = "failed";
          error = `chunk ${plan.chunk.index + 1}/${plan.chunk.count}: ${out.record.error ?? "failed"}`;
          break;
        }
        keys.push(plan.key);
        usages.push(out.record.usage);
        missing += out.record.missing.length;
        for (const a of out.record.answers) {
          const b = byId.get(a.id);
          if (!b) continue;
          const node = snap.nodes[b.unit_id];
          const flags = [a.u ? "doubt" : "", a.m ? "mixed" : "", node?.flags.disclosure ? "collapsed" : ""].filter((f) => f !== "");
          items.push({
            unit_id: b.unit_id,
            y: CLASS_OF[a.c],
            confidence: a.u ? 0.5 : cfg.confidence,
            source: "llm",
            reason: [`llm:${a.c}`, ...flags].join(","),
          });
        }
      }
    } catch (e) {
      if (isBudgetError(e)) {
        budgetStop = { page: job.name, message: (e as Error).message };
        reports.push({ ...base, status: "budget_stopped", error: (e as Error).message, routing: routingRec, routed_unit_ids: routedIds, ...est, calls, cache_hits: hits, spent_usd: spent });
        rt.log?.(`${job.name}: stopped by the budget (${(e as Error).message}); ${docs.length} page(s) done are kept`);
        continue;
      }
      if (e instanceof LlmTransportError && !e.fatal) {
        status = "failed";
        error = e.message;
      } else {
        throw e;
      }
    }

    const finalItems = status === "ok" ? items : [];
    const { doc } = buildDoc(job, cfg, status, finalItems, status === "ok" ? keys : [], status === "ok" ? sumUsage(usages) : sumUsage([]), {
      routing: routingRec,
      ...(error ? { error } : {}),
      ...(missing > 0 ? { unlabeled_missing_ids: missing } : {}),
      chunks: plans.length,
    });
    docs.push(doc);
    if (status === "failed") rt.log?.(`${job.name}: FAILED, no labels written (${error})`);
    reports.push({ ...base, status, ...(error ? { error } : {}), routing: routingRec, routed_unit_ids: routedIds, ...est, calls, cache_hits: hits, spent_usd: spent });
  }

  const byStatus: Record<string, number> = {};
  for (const p of reports) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
  const sum = (f: (p: PageReport) => number): number => reports.reduce((n, p) => n + f(p), 0);
  const report: LlmReport = {
    format: LLM_REPORT_FORMAT,
    format_version: "1.0.0",
    dry_run: cfg.dry_run,
    provider: cfg.provider,
    model: cfg.model,
    prompt_id: cfg.system.prompt_id,
    prompt_sha256: cfg.system.prompt_sha256,
    guide_sha256: cfg.system.guide_sha256,
    prices_usd_per_mtok: cfg.prices,
    budget_stop: budgetStop,
    totals: {
      pages: reports.length,
      by_status: byStatus,
      routed_blocks: sum((p) => p.routed_unit_ids.length),
      chunks: sum((p) => p.chunks),
      cache_hits: sum((p) => p.cache_hits),
      calls: sum((p) => p.calls),
      est_input_tokens: sum((p) => p.est_input_tokens),
      est_output_tokens: sum((p) => p.est_output_tokens),
      est_worst_usd: sum((p) => p.est_worst_usd),
      est_expected_usd: sum((p) => p.est_expected_usd),
      spent_usd: sum((p) => p.spent_usd),
    },
    pages: reports,
  };
  return { docs, report, budgetStop };
}
