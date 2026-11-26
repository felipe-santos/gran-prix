import { llmCacheKey, sha256Of, type Sha256 } from "@gran-prix/contracts";
import type { Chunk } from "./blocks.js";
import { renderUserMessage, type PageHeader } from "./blocks.js";
import type { CacheRecord, LlmResponseCache } from "./cache.js";
import { CACHE_RECORD_FORMAT } from "./cache.js";
import { estimateCall, usageCostUSD, type CallEstimate, type EstimateParams } from "./cost.js";
import type { SystemPrompt } from "./guide.js";
import { validateModelParams, type Effort, type ThinkingMode } from "./models.js";
import {
  ANSWER_SCHEMA,
  correctionMessage,
  isClean,
  validateAnswer,
  type Validation,
} from "./validate.js";
import {
  type LlmLedgerPort,
  type LlmMessage,
  type LlmTransport,
  type LlmUsage,
  type PriceTable,
} from "./types.js";

/** Output contract id recorded in the cache key (the answer format of validate.ts). */
export const OUTPUT_CONTRACT = "block_labels_mcn@1";

export interface CallConfig {
  provider: string;
  model: string;
  prices: PriceTable;
  system: SystemPrompt;
  /** Send `temperature: 0`. false = leave it out (models that reject sampling parameters); recorded, never faked. */
  send_temperature: boolean;
  /** `off` = the model's "no thinking" form; `model-default` (default) leaves `thinking` out. Validated per model (models.ts). */
  thinking?: ThinkingMode | undefined;
  /** `output_config.effort`; left out when undefined. */
  effort?: Effort | undefined;
  /**
   * Tokens added to `max_tokens` so that thinking (billed as output, counted in `max_tokens`) cannot starve the answer.
   * 0 (default) when thinking is off. The ledger reserves `max_tokens` at the output price, so the reserve covers it.
   */
  thinking_headroom_tokens?: number | undefined;
  /** Max output tokens per labeled block (worst case) and fixed overhead; `max_tokens = per * blocks + overhead`. */
  output_tokens_per_block: number;
  output_overhead_tokens: number;
  /** Hard cap of `max_tokens` per call. */
  max_output_tokens: number;
  /** Expected output tokens per block (only for the expected-cost estimate of the plan). */
  expected_output_tokens_per_block: number;
  estimate: EstimateParams;
  on_missing: "fail_page" | "leave_unlabeled";
  /** Re-pay chunks whose cached outcome is a failure. */
  retry_failed: boolean;
}

/**
 * The output contract of the cache key. `thinking` and `effort` change the request (and so the answer) but the key's
 * `params` are fixed by @gran-prix/contracts (temperature, max_tokens), so a non-default value is appended here; the
 * default request keeps the bare id, which keeps every key of a run that predates these params bit-identical.
 */
export const outputContractOf = (cfg: Pick<CallConfig, "thinking" | "effort">): string =>
  OUTPUT_CONTRACT + (cfg.thinking === "off" ? "+thinking=off" : "") + (cfg.effort !== undefined ? `+effort=${cfg.effort}` : "");

/** Throws `ModelParamsError` when the API would reject this combination of model, sampling, thinking and effort. */
export function assertCallConfig(cfg: CallConfig): void {
  validateModelParams({ model: cfg.model, temperature_sent: cfg.send_temperature, thinking: cfg.thinking, effort: cfg.effort });
}

export interface ChunkPlan {
  chunk: Chunk;
  user: string;
  key: Sha256;
  maxTokens: number;
  est: CallEstimate;
  cached: CacheRecord | undefined;
}

export function planChunk(header: PageHeader, chunk: Chunk, cfg: CallConfig, cache: LlmResponseCache): ChunkPlan {
  const user = renderUserMessage(header, chunk);
  const maxTokens = Math.min(
    cfg.max_output_tokens,
    chunk.labeled.length * cfg.output_tokens_per_block + cfg.output_overhead_tokens + (cfg.thinking_headroom_tokens ?? 0),
  );
  const key = llmCacheKey({
    provider: cfg.provider,
    model: cfg.model,
    promptSha256: cfg.system.prompt_sha256,
    inputSha256: sha256Of(user),
    // -1 = "temperature not sent": a different request than temperature 0, hence a different key.
    params: { temperature: cfg.send_temperature ? 0 : -1, max_tokens: maxTokens },
    outputContract: outputContractOf(cfg),
  });
  const est = estimateCall(
    cfg.system.system.length,
    user.length,
    maxTokens,
    Math.min(maxTokens, chunk.labeled.length * cfg.expected_output_tokens_per_block),
    cfg.prices,
    cfg.estimate,
  );
  return { chunk, user, key, maxTokens, est, cached: cache.get(key) };
}

/** A chunk whose answer is on disk and needs no call (a `pending_retry` record needs one; a failure does with `retry_failed`). */
export const isCacheHit = (plan: ChunkPlan, cfg: CallConfig): boolean =>
  plan.cached !== undefined && plan.cached.status !== "pending_retry" && !(plan.cached.status === "failed" && cfg.retry_failed);

export interface ChunkRuntime {
  transport?: LlmTransport | undefined;
  ledger?: LlmLedgerPort | undefined;
  cache: LlmResponseCache;
}

export interface ChunkOutcome {
  record: CacheRecord;
  hit: boolean;
  /** USD actually committed to the ledger by this call (0 on a cache hit). */
  spent_usd: number;
  calls: number;
}

const sumUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
});
const ZERO: LlmUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

const problemText = (v: Validation): string =>
  [
    v.malformed,
    v.unknown.length ? `${v.unknown.length} unknown id(s)` : null,
    v.duplicates.length ? `${v.duplicates.length} repeated id(s)` : null,
    v.missing.length ? `${v.missing.length} missing id(s)` : null,
  ]
    .filter((x) => x !== null)
    .join("; ");

/** Acceptable under the policy: clean, or (leave_unlabeled) nothing wrong but missing ids. */
function acceptable(v: Validation, onMissing: CallConfig["on_missing"]): boolean {
  if (isClean(v)) return true;
  return onMissing === "leave_unlabeled" && v.malformed === null && v.unknown.length === 0 && v.duplicates.length === 0;
}

/**
 * Executes one chunk: cache lookup, then (at most) two paid calls. EVERY paid call is preceded by
 * `ledger.reserve(worst case)` and followed by `commit(actual)`; a call that throws before billing is `release()`d.
 * `BudgetExceededError` from the reserve propagates untouched (nothing was spent for that call). When the budget
 * (or the network) stops the chunk between the first answer and its retry, the first answer is cached as
 * `pending_retry`, so a later run resumes at the retry and never pays the first call twice.
 */
export async function runChunk(plan: ChunkPlan, cfg: CallConfig, rt: ChunkRuntime): Promise<ChunkOutcome> {
  const cached = plan.cached;
  if (cached && isCacheHit(plan, cfg)) return { record: cached, hit: true, spent_usd: 0, calls: 0 };
  const { transport, ledger } = rt;
  if (!transport || !ledger) throw new Error("LLM call needed but no transport/ledger was provided");
  assertCallConfig(cfg);
  transport.assertReady?.();

  const asked = plan.chunk.labeled.map((b) => b.id);
  const messages: LlmMessage[] = [{ role: "user", content: plan.user }];
  let usage = ZERO;
  let spent = 0;
  let raw = "";
  let v: Validation | undefined;
  let calls = 0;
  let start = 1;
  const base = cached?.status === "pending_retry" ? cached.attempts : 0;

  const askAgain = (text: string, validation: Validation): void => {
    messages.push({ role: "assistant", content: text === "" ? "(empty answer)" : text });
    messages.push({ role: "user", content: correctionMessage(validation) });
  };
  if (cached?.status === "pending_retry") {
    // Resume: the first (paid) answer is on disk; only the retry is left.
    raw = cached.raw;
    usage = cached.usage;
    v = validateAnswer(raw, asked);
    askAgain(raw, v);
    start = 2;
  }

  for (let attempt = start; attempt <= 2; attempt++) {
    const chars = messages.reduce((n, m) => n + m.content.length, 0);
    const worst = estimateCall(cfg.system.system.length, chars, plan.maxTokens, plan.maxTokens, cfg.prices, cfg.estimate).worst_usd;
    let reservation;
    try {
      reservation = ledger.reserve(worst, `llm ${plan.key.slice(7, 19)} attempt ${attempt}`);
    } catch (e) {
      if (attempt === 2 && v !== undefined) {
        rt.cache.put({ format: CACHE_RECORD_FORMAT, key: plan.key, status: "pending_retry", answers: [], missing: [], attempts: base + calls, usage, raw });
      }
      throw e;
    }
    let response;
    try {
      response = await transport.complete({
        model: cfg.model,
        system: cfg.system.system,
        messages,
        maxTokens: plan.maxTokens,
        ...(cfg.send_temperature ? { temperature: 0 as const } : {}),
        ...(cfg.thinking !== undefined ? { thinking: cfg.thinking } : {}),
        ...(cfg.effort !== undefined ? { effort: cfg.effort } : {}),
        schema: ANSWER_SCHEMA,
      });
    } catch (e) {
      reservation.release(); // nothing was billed for a call that failed
      if (attempt === 2 && v !== undefined) {
        rt.cache.put({ format: CACHE_RECORD_FORMAT, key: plan.key, status: "pending_retry", answers: [], missing: [], attempts: base + calls, usage, raw });
      }
      throw e;
    }
    calls++;
    const cost = usageCostUSD(response.usage, cfg.prices);
    reservation.commit(cost);
    spent += cost;
    usage = sumUsage(usage, response.usage);
    raw = response.text;
    v = validateAnswer(response.text, asked);
    if (acceptable(v, cfg.on_missing)) break;
    if (attempt === 1) askAgain(response.text, v);
  }

  const final = v as Validation;
  const ok = acceptable(final, cfg.on_missing);
  const record: CacheRecord = {
    format: CACHE_RECORD_FORMAT,
    key: plan.key,
    status: ok ? "ok" : "failed",
    answers: ok ? final.answers : [],
    missing: ok ? final.missing : [],
    attempts: base + calls,
    usage,
    raw,
    ...(ok ? {} : { error: problemText(final) }),
  };
  rt.cache.put(record);
  return { record, hit: false, spent_usd: spent, calls };
}
