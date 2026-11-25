import { median } from "./reduction.js";

/**
 * Hook for Claude's own token count (protocol 10: check the cl100k count against the API on 30 pages and report the
 * drift). This file holds the INTERFACE and a fake; nothing here calls the API. The real transport (the Messages
 * count-tokens endpoint) needs the owner's key and is wired later, behind the budget ledger of the CLI.
 *
 * The API counts a whole request, so the count of a text includes the few tokens of the message wrapper. Measure
 * that overhead once with `claudeOverhead` (a fixed one-character text) and subtract it, or report the drift on
 * pages large enough for it not to matter; the choice is part of the 30-page check, not of this package.
 */

export interface ClaudeCountRequest {
  /** Model id the count is for (the count depends on the model's tokenizer). */
  model: string;
  /** The text, sent as the only user message. */
  text: string;
}

/** What a transport has to do: one request, the `input_tokens` of the answer. */
export interface ClaudeTokenTransport {
  countTokens(req: ClaudeCountRequest): Promise<{ input_tokens: number }>;
}

export async function countTokensClaude(transport: ClaudeTokenTransport, model: string, text: string): Promise<number> {
  const r = await transport.countTokens({ model, text });
  if (!Number.isInteger(r.input_tokens) || r.input_tokens < 0) throw new Error(`the token-count transport returned input_tokens = ${String(r.input_tokens)}`);
  return r.input_tokens;
}

/** Tokens the request wrapper adds, measured with a one-character text. */
export async function claudeOverhead(transport: ClaudeTokenTransport, model: string): Promise<number> {
  return countTokensClaude(transport, model, "a");
}

/**
 * Deterministic fake for tests: `ceil(chars / charsPerToken) + overhead`, and a log of the requests it saw.
 * It says nothing about Claude's tokenizer; it only makes the plumbing testable offline.
 */
export class FakeClaudeTransport implements ClaudeTokenTransport {
  readonly requests: ClaudeCountRequest[] = [];
  constructor(
    private readonly charsPerToken = 3.5,
    private readonly overhead = 7,
  ) {}
  async countTokens(req: ClaudeCountRequest): Promise<{ input_tokens: number }> {
    this.requests.push(req);
    return { input_tokens: Math.ceil([...req.text].length / this.charsPerToken) + this.overhead };
  }
}

export interface TokenDrift {
  n_pages: number;
  /** Median over pages of claude / cl100k - 1 (positive: Claude counts more tokens). */
  median_relative_drift: number | null;
  /** Range of the per-page drift. */
  min: number | null;
  max: number | null;
  /** Share of pages where Claude counts more. */
  share_claude_higher: number | null;
}

/** Drift of the cl100k count against Claude's, per page (pages with a zero cl100k count are skipped). */
export function tokenDrift(pairs: ReadonlyArray<{ cl100k: number; claude: number }>): TokenDrift {
  const d = pairs.filter((p) => p.cl100k > 0).map((p) => p.claude / p.cl100k - 1);
  return {
    n_pages: d.length,
    median_relative_drift: median(d),
    min: d.length > 0 ? Math.min(...d) : null,
    max: d.length > 0 ? Math.max(...d) : null,
    share_claude_higher: d.length > 0 ? d.filter((x) => x > 0).length / d.length : null,
  };
}
