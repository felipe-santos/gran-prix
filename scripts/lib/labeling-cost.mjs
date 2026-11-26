// Cost estimate of the labeling plan (protocol 5.6: "before the first call, gp computes the estimate over the real
// corpus and compares it with the cap"). Pure arithmetic over token counts; the counts come from the real prompt
// (scripts/labeling-plan-dom-v0.mjs). No network, no key.
//
// What is and is not known:
//  - The tokenizer of Claude is not public. The counts are cl100k_base (js-tiktoken, the proxy of protocol 10).
//    Two scenarios are reported for every figure:
//      expected: cl100k as it is, 5% of the chunks answered twice (the bounded retry of the labeler),
//                no thinking tokens (they are 0 where thinking is off and UNMEASURED where it cannot be turned off);
//      upper:    cl100k x 1.35 (the top of the 1.0-1.35 range of the newer Claude tokenizers over older ones, claude-api
//                reference of 2026-11), 10% retries, and, where thinking runs, the whole thinking headroom of every call
//                billed as output.
//  - Cache: the system prompt is a cache WRITE (1.25x input) on the first call of each prompt version and a cache READ
//    afterwards, assuming the calls of a phase are made back to back (the 5-minute window is renewed by every read).
//  - Batch API (-50%) is NOT implemented by the labeler (it calls /v1/messages one chunk at a time); it is reported
//    apart as information.

export const TOKEN_UNCERTAINTY = 1.35;
export const SCENARIOS = {
  expected: { mult: 1, retry: 0.05, thinking_headroom: false },
  upper: { mult: TOKEN_UNCERTAINTY, retry: 0.1, thinking_headroom: true },
};
/** Haiku 5.5 is priced for prompts up to 100k tokens (the table of the lane): above it another rate card applies. */
export const HAIKU_TIER_TOKENS = 100_000;

const perMtok = (tokens, usdPerMtok) => (tokens * usdPerMtok) / 1_000_000;

/**
 * One phase under one scenario.
 *  chunks: [{ user_tokens, out_tokens }] (one entry per call of ONE iteration);
 *  iterations: how many times the phase is run (prompt-dev: up to 3 prompt versions; every other phase 1);
 *  thinking_on: the model thinks in this configuration (Opus always; Sonnet/Haiku only with thinking "model-default");
 *  thinking_headroom_tokens: what the labeler adds to max_tokens per call.
 */
export function phaseCost({ chunks, system_tokens, prices, iterations = 1, scenario, thinking_on, thinking_headroom_tokens }) {
  const s = SCENARIOS[scenario];
  const base = chunks.length * iterations;
  if (base === 0) return { calls: 0, retried_calls: 0, uncached_input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0, thinking_tokens: 0, usd: 0 };
  const retried = Math.ceil(base * s.retry);
  const calls = base + retried;
  const userOnce = chunks.reduce((n, c) => n + c.user_tokens, 0);
  const outOnce = chunks.reduce((n, c) => n + c.out_tokens, 0);
  // a retried call re-sends its chunk and answers it again: scale the per-iteration tokens by (1 + retry)
  const uncached = Math.ceil(userOnce * iterations * (1 + s.retry) * s.mult);
  const answer = Math.ceil(outOnce * iterations * (1 + s.retry) * s.mult);
  const sys = Math.ceil(system_tokens * s.mult);
  const writes = iterations; // one cache write per prompt version
  const cacheWrite = sys * writes;
  const cacheRead = sys * Math.max(0, calls - writes);
  const thinking = thinking_on && s.thinking_headroom ? thinking_headroom_tokens * calls : 0;
  const usd =
    perMtok(uncached, prices.input_usd_per_mtok) +
    perMtok(cacheWrite, prices.cache_write_usd_per_mtok) +
    perMtok(cacheRead, prices.cache_read_usd_per_mtok) +
    perMtok(answer + thinking, prices.output_usd_per_mtok);
  return { calls, retried_calls: retried, uncached_input_tokens: uncached, cache_write_tokens: cacheWrite, cache_read_tokens: cacheRead, output_tokens: answer, thinking_tokens: thinking, usd };
}

/**
 * Largest prompt (system + user) of any call under the upper scenario: Haiku 5.5's price holds only up to 100k.
 */
export function maxPromptTokens(chunks, system_tokens, scenario = "upper") {
  const m = SCENARIOS[scenario].mult;
  return Math.ceil(chunks.reduce((n, c) => Math.max(n, c.user_tokens), 0) * m + system_tokens * m);
}

/**
 * All phases of one model. `phases`: [{ name, chunks, iterations, interactive }]; `model`: { id, prices, thinking_on,
 * thinking_headroom_tokens, thinking_note }. Returns per phase and total figures for both scenarios plus the cap check.
 */
export function modelCost({ model, system_tokens, phases, cap_usd }) {
  const out = { model: model.id, configuration: model.configuration, thinking_note: model.thinking_note, phases: [], totals: {} };
  for (const sc of Object.keys(SCENARIOS)) out.totals[sc] = { calls: 0, usd: 0, output_tokens: 0, thinking_tokens: 0, uncached_input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0 };
  let batchable = 0;
  for (const ph of phases) {
    const row = { phase: ph.name, pages: ph.pages, iterations: ph.iterations ?? 1, interactive: ph.interactive === true, max_prompt_tokens_upper: maxPromptTokens(ph.chunks, system_tokens) };
    for (const sc of Object.keys(SCENARIOS)) {
      const c = phaseCost({ chunks: ph.chunks, system_tokens, prices: model.prices, iterations: ph.iterations ?? 1, scenario: sc, thinking_on: model.thinking_on, thinking_headroom_tokens: model.thinking_headroom_tokens });
      row[sc] = c;
      for (const k of Object.keys(out.totals[sc])) out.totals[sc][k] += c[k];
      if (sc === "expected" && ph.interactive !== true) batchable += c.usd;
    }
    out.phases.push(row);
  }
  out.max_prompt_tokens_upper = Math.max(...out.phases.map((p) => p.max_prompt_tokens_upper));
  out.haiku_tier_ok = model.id === "claude-haiku-5-5" ? out.max_prompt_tokens_upper <= HAIKU_TIER_TOKENS : null;
  out.within_cap = { expected: out.totals.expected.usd <= cap_usd, upper: out.totals.upper.usd <= cap_usd };
  out.batch_info = { note: "Batch API (-50%) is not implemented by the labeler; this is what the non-interactive phases would cost with it, expected scenario.", expected_usd_if_batched: out.totals.expected.usd - batchable * 0.5 };
  return out;
}
