import type { NodeLabels, PageSnapshot } from "@gran-prix/contracts";

/**
 * LLM labeler: INTERFACE ONLY. No provider is called anywhere in this package.
 *
 * ADR-006 / experimento-dom-v0 section 5: the LLM sees numbered blocks of a page and answers keep/drop
 * (or main/support/noise) per block id, only for the units the cheaper labelers disagree on. When it
 * is implemented it must:
 *
 *  - call `ledger.reserve(estimatedUSD, note)` BEFORE every paid call (it throws `BudgetExceededError`
 *    when the hard cap would be passed), then `commit(actualUSD)` or `release()`;
 *  - use temperature 0 and cache every response by key, so a re-run costs nothing and a stage that
 *    declares `determinism: "cached-external"` stays reproducible;
 *  - record `labeler.llm` (model, prompt id and sha256, `response_cache_keys`) in the NodeLabels it emits;
 *  - emit items with `source: "llm"`.
 */

/** What the labeler needs from the runner ledger (`StageLedger` of `@gran-prix/cli` satisfies it). */
export interface LlmLedgerPort {
  reserve(costUSD: number, note?: string): { commit(actualUSD?: number): void; release(): void };
  readonly capUSD: number;
  remainingUSD(): number;
}

/** One numbered block of the page as the model sees it. */
export interface LlmBlock {
  /** Snapshot node idx: becomes `unit_id` of the answer. */
  unit_id: number;
  text: string;
}

export interface LlmLabelRequest {
  snapshot: PageSnapshot;
  /** Only the units to decide; the rest of the page is context-free for the model. */
  blocks: readonly LlmBlock[];
  model: string;
  prompt_id: string;
  ledger: LlmLedgerPort;
}

export type LlmLabeler = (request: LlmLabelRequest) => Promise<NodeLabels>;

export class LlmLabelerNotEnabledError extends Error {
  constructor() {
    super("LLM labeling is not enabled: this build has no provider, and no paid call is ever made without one");
    this.name = "LlmLabelerNotEnabledError";
  }
}

/** The only implementation for now: it throws before touching the ledger. */
export const llmLabelerStub: LlmLabeler = () => Promise.reject(new LlmLabelerNotEnabledError());
