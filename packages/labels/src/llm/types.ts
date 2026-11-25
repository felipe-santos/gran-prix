/**
 * Shared types of the LLM labeler (experimento-dom-v0 section 5, guia de anotacao sections 1-4).
 *
 * Nothing here talks to a network. The transport is a port: `AnthropicTransport` (anthropic.ts) is the
 * real one, `FakeTransport` (fake.ts) is what the tests use.
 */

/** What the labeler needs from the runner ledger (`StageLedger` of `@gran-prix/cli` satisfies it). */
export interface LlmLedgerPort {
  reserve(costUSD: number, note?: string): { commit(actualUSD?: number): void; release(): void };
  readonly capUSD: number;
  remainingUSD(): number;
}

/**
 * USD per million tokens. REQUIRED input, never a default: the protocol says prices must be checked
 * on the day of the run (section 5.6). Cache prices default to the documented multipliers of the
 * input price (write 1.25x, read 0.1x) only when the caller leaves them out.
 */
export interface PriceTable {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  cache_write_usd_per_mtok?: number;
  cache_read_usd_per_mtok?: number;
}

/** Token usage of one response, as the API reports it. */
export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  model: string;
  /** The frozen system prompt. The transport marks it cacheable. */
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  /** Always 0 (protocol). `undefined` = leave the parameter out (models that reject sampling parameters). */
  temperature?: 0;
  /** JSON Schema the answer must follow (structured output). */
  schema: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  stopReason: string | null;
  usage: LlmUsage;
}

/** A provider. `complete` is the ONLY place a paid call can happen. */
export interface LlmTransport {
  readonly provider: string;
  /** Throws when the transport cannot be used (no key, ...). Called BEFORE the ledger is touched. */
  assertReady?(): void;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** An error of the transport. `fatal` = retrying other pages is pointless (bad key, unknown model). */
export class LlmTransportError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = "LlmTransportError";
  }
}

export class MissingApiKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set: the LLM labeler cannot make a call (dry_run and cache hits need no key)");
    this.name = "MissingApiKeyError";
  }
}

/** True for the `BudgetExceededError` of the runner ledger (this package cannot import it). */
export const isBudgetError = (e: unknown): boolean => e instanceof Error && e.name === "BudgetExceededError";

/** One numbered block: block id `n<unit_id>`, the unit being the element that owns the text. */
export interface Block {
  unit_id: number;
  /** `n<unit_id>`: the id the model sees and answers with (the `data-gp-id` of the element). */
  id: string;
  tag: string;
  /** Ancestor path ending at the element, e.g. `main>article>p`. */
  path: string;
  /** Collapsed own text, cut to `block_chars`. */
  text: string;
}

export type LlmClass = "M" | "S" | "N";

/** A validated answer for one block. */
export interface BlockAnswer {
  id: string;
  c: LlmClass;
  /** Doubt: the model is unsure (confidence 0.5, goes to the human queue). */
  u: boolean;
  /** Mixed element (guide 2.4). */
  m: boolean;
}
