import type { LlmUsage, PriceTable } from "./types.js";

const cacheWrite = (p: PriceTable): number => p.cache_write_usd_per_mtok ?? p.input_usd_per_mtok * 1.25;
const cacheRead = (p: PriceTable): number => p.cache_read_usd_per_mtok ?? p.input_usd_per_mtok * 0.1;

/** Cost of a usage record under a price table, in USD. */
export function usageCostUSD(usage: LlmUsage, prices: PriceTable): number {
  return (
    (usage.input_tokens * prices.input_usd_per_mtok +
      usage.cache_creation_input_tokens * cacheWrite(prices) +
      usage.cache_read_input_tokens * cacheRead(prices) +
      usage.output_tokens * prices.output_usd_per_mtok) /
    1_000_000
  );
}

export function assertPrices(p: PriceTable): void {
  if (typeof p !== "object" || p === null) throw new TypeError("prices must be an object");
  for (const k of ["input_usd_per_mtok", "output_usd_per_mtok"] as const) {
    if (typeof p[k] !== "number") throw new TypeError(`prices.${k} is required`);
  }
  for (const [k, v] of Object.entries(p)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new RangeError(`prices.${k} must be a finite number >= 0 (got ${String(v)})`);
  }
}

export interface EstimateParams {
  /** Characters per token used to estimate input size offline. Conservative (low) by default: 3. */
  chars_per_token: number;
  /** Multiplier applied to the input estimate in the WORST-case reservation. Default 1.2. */
  safety_factor: number;
}

export const DEFAULT_ESTIMATE: EstimateParams = { chars_per_token: 3, safety_factor: 1.2 };

/** Offline token estimate of `chars` characters (the real count comes back in `usage`). */
export const estimateTokens = (chars: number, charsPerToken: number): number => Math.ceil(chars / charsPerToken) + 8;

export interface CallEstimate {
  input_tokens: number;
  max_output_tokens: number;
  /** Worst case: every input token billed as a cache WRITE (the dearest input rate) and `max_tokens` of output. */
  worst_usd: number;
  /** Expected, FIRST call of a cache window: system prompt as a cache write, the rest as plain input, `expected_output_tokens` of output. */
  expected_usd: number;
  /** Expected, call inside a warm cache window (the previous call was < 5 min before): system prompt as a cache READ. */
  expected_cached_usd: number;
}

/**
 * Estimate of one call. The worst case is what `ledger.reserve()` is asked for before the call:
 * `(system + user tokens) x safety x max(input, cache-write price) + max_tokens x output price`.
 * `max_tokens` is the ceiling of EVERYTHING billed as output, thinking tokens included, so a thinking model is covered
 * as long as the caller put the thinking headroom into `max_tokens` (chunk-call.ts does).
 */
export function estimateCall(
  systemChars: number,
  userChars: number,
  maxTokens: number,
  expectedOutputTokens: number,
  prices: PriceTable,
  est: EstimateParams = DEFAULT_ESTIMATE,
): CallEstimate {
  const sys = estimateTokens(systemChars, est.chars_per_token);
  const usr = estimateTokens(userChars, est.chars_per_token);
  const dearestIn = Math.max(prices.input_usd_per_mtok, cacheWrite(prices));
  const worst = ((sys + usr) * est.safety_factor * dearestIn + maxTokens * prices.output_usd_per_mtok) / 1_000_000;
  const expected = (sys * cacheWrite(prices) + usr * prices.input_usd_per_mtok + expectedOutputTokens * prices.output_usd_per_mtok) / 1_000_000;
  const expectedCached = (sys * cacheRead(prices) + usr * prices.input_usd_per_mtok + expectedOutputTokens * prices.output_usd_per_mtok) / 1_000_000;
  return { input_tokens: sys + usr, max_output_tokens: maxTokens, worst_usd: worst, expected_usd: expected, expected_cached_usd: expectedCached };
}
