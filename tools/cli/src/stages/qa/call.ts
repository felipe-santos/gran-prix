import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, llmCacheKey, sha256Of, type Sha256 } from "@gran-prix/contracts";
import { DEFAULT_ESTIMATE, estimateCall, usageCostUSD, type EstimateParams, type LlmLedgerPort, type LlmUsage, type PriceTable } from "@gran-prix/labels";
import { paramsKeyPart, type ResolvedParams } from "./model-params.js";
import { contentChars, type QaMessage, type QaRequest, type QaTransport } from "./transport.js";

/**
 * One paid call, the way the labeler makes it, for the three QA stages (generate, answer, judge):
 *
 *  - the answer is looked up in a content-hash cache FIRST (key = provider, model, prompt hash, hash of the exact
 *    messages, the request knobs, the output contract), so a re-run, or another pipeline asking the same question,
 *    never pays twice. A FAILED outcome is cached too (temperature aside, the model would fail again);
 *  - EVERY paid attempt is preceded by `ledger.reserve(worst case)` and followed by `commit(actual)`; a call that
 *    throws before billing is `release()`d; a refused reservation propagates untouched (nothing was spent);
 *  - one bounded correction retry when the answer does not parse; if the budget (or the network) stops the chunk
 *    between the first answer and its retry, the first answer is cached as `pending_retry`, so a later run resumes at
 *    the retry and never pays the first call twice.
 */

export const QA_CACHE_FORMAT = "gran-prix.qa-response-cache" as const;

export interface QaCacheRecord {
  format: typeof QA_CACHE_FORMAT;
  key: Sha256;
  status: "ok" | "failed" | "pending_retry";
  /** Raw text of the last response. */
  text: string;
  attempts: number;
  usage: LlmUsage;
  error?: string;
}

export interface QaCache {
  get(key: string): QaCacheRecord | undefined;
  put(record: QaCacheRecord): void;
}

export class MemoryQaCache implements QaCache {
  readonly records = new Map<string, QaCacheRecord>();
  get(key: string): QaCacheRecord | undefined {
    return this.records.get(key);
  }
  put(record: QaCacheRecord): void {
    this.records.set(record.key, record);
  }
}

/** One JSON file per key under `dir`, written atomically (temp file + rename). */
export class FsQaCache implements QaCache {
  constructor(readonly dir: string) {}
  private file(key: string): string {
    return join(this.dir, `${key.replace(/^sha256:/, "")}.json`);
  }
  get(key: string): QaCacheRecord | undefined {
    const f = this.file(key);
    if (!existsSync(f)) return undefined;
    const rec = JSON.parse(readFileSync(f, "utf8")) as QaCacheRecord;
    return rec.format === QA_CACHE_FORMAT && rec.key === key ? rec : undefined;
  }
  put(record: QaCacheRecord): void {
    const f = this.file(record.key);
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record)}\n`);
    renameSync(tmp, f);
  }
}

export const ZERO_USAGE: LlmUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
export const sumUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
});
/** Every input token of a usage record (plain + cache write + cache read). */
export const inputTokens = (u: LlmUsage): number => u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;

export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

/** What a call needs, fixed by the stage. */
export interface CallModel {
  provider: string;
  model: string;
  prices: PriceTable;
  params: ResolvedParams;
  estimate?: EstimateParams;
}

export interface CallPlan<T> {
  model: CallModel;
  system: string;
  /** sha256 of `system` plus the output instructions: the frozen `prompt_sha256`. */
  promptSha256: Sha256;
  messages: QaMessage[];
  maxTokens: number;
  /** Output contract id (`qa.generate@1`, ...): part of the cache key. */
  contract: string;
  schema?: Record<string, unknown>;
  parse(text: string): Parsed<T>;
  /** Message sent when the first answer does not parse (absent: no retry, a bad answer is final). */
  correction?(problem: string): string;
}

export interface CallRuntime {
  transport?: QaTransport | undefined;
  ledger?: LlmLedgerPort | undefined;
  cache: QaCache;
  /** Pay again for calls whose cached outcome is a failure. */
  retryFailed?: boolean;
}

export interface CallEst {
  key: Sha256;
  cached: QaCacheRecord | undefined;
  hit: boolean;
  worst_usd: number;
  expected_usd: number;
  input_tokens: number;
}

export function cacheKeyOf<T>(plan: CallPlan<T>): Sha256 {
  return llmCacheKey({
    provider: plan.model.provider,
    model: plan.model.model,
    promptSha256: plan.promptSha256,
    inputSha256: sha256Of(canonicalJson(plan.messages)),
    // -1 = "temperature not sent": a different request than temperature 0, hence a different key.
    params: { temperature: plan.model.params.send_temperature ? 0 : -1, max_tokens: plan.maxTokens },
    outputContract: `${plan.contract}|${paramsKeyPart(plan.model.params)}`,
  });
}

export const isHit = (rec: QaCacheRecord | undefined, retryFailed: boolean | undefined): boolean =>
  rec !== undefined && rec.status !== "pending_retry" && !(rec.status === "failed" && retryFailed === true);

/** Plans a call without making it: cache state and cost estimates (the dry run). */
export function estimateOf<T>(plan: CallPlan<T>, cache: QaCache, retryFailed?: boolean, expectedOutputTokens = 60): CallEst {
  const key = cacheKeyOf(plan);
  const cached = cache.get(key);
  const est = estimateCall(plan.system.length, contentChars(plan.messages), plan.maxTokens, Math.min(plan.maxTokens, expectedOutputTokens), plan.model.prices, plan.model.estimate ?? DEFAULT_ESTIMATE);
  return { key, cached, hit: isHit(cached, retryFailed), worst_usd: est.worst_usd, expected_usd: est.expected_usd, input_tokens: est.input_tokens };
}

export interface CallOutcome<T> {
  key: Sha256;
  /** The parsed answer; undefined when the call failed (`error` says why). */
  value?: T;
  error?: string;
  text: string;
  usage: LlmUsage;
  attempts: number;
  hit: boolean;
  /** USD committed to the ledger by THIS execution (0 on a cache hit). */
  spent_usd: number;
  /** USD the usage costs at the price table (also on a hit: the reports show the cost of the study, not of the run). */
  cost_usd: number;
  calls: number;
}

function request<T>(plan: CallPlan<T>, messages: QaMessage[]): QaRequest {
  const p = plan.model.params;
  return {
    model: plan.model.model,
    system: plan.system,
    messages,
    maxTokens: plan.maxTokens,
    ...(p.send_temperature ? { temperature: 0 as const } : {}),
    ...(p.thinking_wire !== null ? { thinking: p.thinking_wire } : {}),
    ...(p.effort !== null ? { effort: p.effort } : {}),
    ...(plan.schema !== undefined ? { schema: plan.schema } : {}),
  };
}

/** Executes a planned call: cache lookup, then (at most) two paid attempts. See the header for the money rules. */
export async function runCall<T>(plan: CallPlan<T>, rt: CallRuntime): Promise<CallOutcome<T>> {
  const key = cacheKeyOf(plan);
  const cached = rt.cache.get(key);
  const price = (u: LlmUsage): number => usageCostUSD(u, plan.model.prices);
  if (cached !== undefined && isHit(cached, rt.retryFailed)) {
    const parsed = cached.status === "ok" ? plan.parse(cached.text) : ({ ok: false, problem: cached.error ?? "failed" } as const);
    return {
      key,
      ...(parsed.ok ? { value: parsed.value } : { error: cached.status === "ok" ? parsed.problem : (cached.error ?? "failed") }),
      text: cached.text,
      usage: cached.usage,
      attempts: cached.attempts,
      hit: true,
      spent_usd: 0,
      cost_usd: price(cached.usage),
      calls: 0,
    };
  }
  const { transport, ledger } = rt;
  if (!transport || !ledger) throw new Error("an LLM call is needed but no transport/ledger was provided");
  transport.assertReady?.();

  const messages: QaMessage[] = [...plan.messages];
  let usage = ZERO_USAGE;
  let spent = 0;
  let calls = 0;
  let raw = "";
  let parsed: Parsed<T> | undefined;
  let start = 1;
  const base = cached?.status === "pending_retry" ? cached.attempts : 0;
  const askAgain = (text: string, problem: string): boolean => {
    if (plan.correction === undefined) return false;
    messages.push({ role: "assistant", content: text === "" ? "(empty answer)" : text });
    messages.push({ role: "user", content: plan.correction(problem) });
    return true;
  };
  if (cached?.status === "pending_retry") {
    // Resume: the first (paid) answer is on disk; only the retry is left.
    raw = cached.text;
    usage = cached.usage;
    parsed = plan.parse(raw);
    if (!parsed.ok) askAgain(raw, parsed.problem);
    start = 2;
  }
  const park = (): void => rt.cache.put({ format: QA_CACHE_FORMAT, key, status: "pending_retry", text: raw, attempts: base + calls, usage });

  for (let attempt = start; attempt <= 2; attempt++) {
    const est = estimateCall(plan.system.length, contentChars(messages), plan.maxTokens, plan.maxTokens, plan.model.prices, plan.model.estimate ?? DEFAULT_ESTIMATE);
    let reservation;
    try {
      reservation = ledger.reserve(est.worst_usd, `qa ${plan.contract} ${key.slice(7, 19)} attempt ${attempt}`);
    } catch (e) {
      if (attempt === 2 && parsed !== undefined) park();
      throw e;
    }
    let response;
    try {
      response = await transport.complete(request(plan, messages));
    } catch (e) {
      reservation.release(); // nothing was billed for a call that failed
      if (attempt === 2 && parsed !== undefined) park();
      throw e;
    }
    calls++;
    const cost = price(response.usage);
    reservation.commit(cost);
    spent += cost;
    usage = sumUsage(usage, response.usage);
    raw = response.text;
    parsed = plan.parse(raw);
    if (parsed.ok) break;
    if (attempt === 1 && !askAgain(raw, parsed.problem)) break;
  }

  const final = parsed as Parsed<T>;
  rt.cache.put({
    format: QA_CACHE_FORMAT,
    key,
    status: final.ok ? "ok" : "failed",
    text: raw,
    attempts: base + calls,
    usage,
    ...(final.ok ? {} : { error: final.problem }),
  });
  return {
    key,
    ...(final.ok ? { value: final.value } : { error: final.problem }),
    text: raw,
    usage,
    attempts: base + calls,
    hit: false,
    spent_usd: spent,
    cost_usd: price(usage),
    calls,
  };
}

export interface PoolResult<O> {
  /** Input order; `undefined` = never started (an earlier item failed first). */
  results: Array<O | undefined>;
  /** The first error (a budget stop, a network error); work already in flight finished and is in `results`. */
  error?: unknown;
}

/** Runs `fn` over `items` with at most `concurrency` in flight. The first error stops NEW work and is returned, not thrown. */
export async function mapPool<I, O>(items: readonly I[], concurrency: number, fn: (item: I, index: number) => Promise<O>): Promise<PoolResult<O>> {
  const results = new Array<O | undefined>(items.length).fill(undefined);
  let next = 0;
  let failed: { e: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (failed === undefined) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i] as I, i);
      } catch (e) {
        failed ??= { e };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()));
  return failed === undefined ? { results } : { results, error: failed.e };
}
