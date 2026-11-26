import { LlmTransportError, MissingApiKeyError, type LlmResponse, type LlmUsage } from "@gran-prix/labels";

/**
 * The transport port of the QA tool. It is the labeler's pattern (`LlmTransport`: ONE place a paid call can happen,
 * a real fetch-based implementation, a fake for tests) extended with what the QA calls need and the labeler's request
 * type has no room for: content blocks with a cache mark (the page is the cacheable prefix of the 5 questions that
 * share it), `thinking` and `effort`, and an optional output schema (the respondent answers in free text).
 */

export interface QaBlock {
  text: string;
  /** Mark the prefix up to and including this block as cacheable (prompt caching). */
  cache?: boolean;
}
export type QaContent = string | QaBlock[];
export interface QaMessage {
  role: "user" | "assistant";
  content: QaContent;
}

export interface QaRequest {
  model: string;
  /** The frozen system prompt. The transport marks it cacheable. */
  system: string;
  messages: QaMessage[];
  maxTokens: number;
  /** Present (0) only when `send_temperature`; absent = the parameter is left out. */
  temperature?: 0;
  /** `thinking` as sent on the wire; absent = nothing sent. */
  thinking?: { type: string };
  effort?: string;
  /** JSON Schema the answer must follow (structured output); absent = free text. */
  schema?: Record<string, unknown>;
}

export interface QaTransport {
  readonly provider: string;
  /** Throws when the transport cannot be used (no key, ...). Called BEFORE the ledger is touched. */
  assertReady?(): void;
  complete(request: QaRequest): Promise<LlmResponse>;
}

/** Total characters of a message list (what the estimate of a reservation reads). */
export const contentChars = (messages: readonly QaMessage[]): number =>
  messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : m.content.reduce((k, b) => k + b.text.length, 0)), 0);

/** Plain text of a message (blocks joined). */
export const contentText = (c: QaContent): string => (typeof c === "string" ? c : c.map((b) => b.text).join(""));

// ---------------------------------------------------------------------------------------------------------------- real

export const ANTHROPIC_API_VERSION = "2023-06-01";
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface QaAnthropicOptions {
  /** Where the key is looked up. Default `process.env`. Only `ANTHROPIC_API_KEY` is read. */
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

const FATAL_STATUS = new Set([400, 401, 403, 404]);

/**
 * The Messages API over `fetch` (no SDK, no lockfile change; the request is visible and testable with an injected
 * `fetch`). Same guarantees as the labeler's `AnthropicTransport`: the key comes only from `ANTHROPIC_API_KEY`, at call
 * time, lives in a private field, goes only in the `x-api-key` header, is scrubbed from every error and never
 * serialised; nothing is retried here (a retry is a second paid call and must go through the ledger).
 */
export class QaAnthropicTransport implements QaTransport {
  readonly provider = "anthropic";
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(opts: QaAnthropicOptions = {}) {
    this.#env = opts.env ?? process.env;
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.#baseUrl = (opts.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#timeoutMs = opts.timeoutMs ?? 120_000;
  }

  #key(): string {
    const k = this.#env["ANTHROPIC_API_KEY"];
    if (k === undefined || k.trim() === "") throw new MissingApiKeyError();
    return k.trim();
  }

  assertReady(): void {
    this.#key();
  }

  toJSON(): { provider: string } {
    return { provider: this.provider };
  }

  /** The JSON body of a request (exposed for tests: it is what would leave the machine). */
  static body(req: QaRequest): Record<string, unknown> {
    const blocks = (c: QaContent): unknown =>
      typeof c === "string" ? c : c.map((b) => ({ type: "text", text: b.text, ...(b.cache ? { cache_control: { type: "ephemeral" } } : {}) }));
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: req.messages.map((m) => ({ role: m.role, content: blocks(m.content) })),
    };
    const out: Record<string, unknown> = {};
    if (req.schema !== undefined) out["format"] = { type: "json_schema", schema: req.schema };
    if (req.effort !== undefined) out["effort"] = req.effort;
    if (Object.keys(out).length > 0) body["output_config"] = out;
    if (req.temperature !== undefined) body["temperature"] = req.temperature;
    if (req.thinking !== undefined) body["thinking"] = req.thinking;
    return body;
  }

  async complete(req: QaRequest): Promise<LlmResponse> {
    const key = this.#key();
    const scrub = (s: string): string => s.split(key).join("[redacted]");
    let res: Awaited<ReturnType<FetchLike>>;
    let text: string;
    try {
      res = await this.#fetch(`${this.#baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_API_VERSION },
        body: JSON.stringify(QaAnthropicTransport.body(req)),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      throw new LlmTransportError(scrub(`network error: ${e instanceof Error ? e.message : String(e)}`), null, false);
    }
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const err = (JSON.parse(text) as { error?: { type?: string; message?: string } }).error;
        if (err?.message) detail = `${err.type ?? "error"}: ${err.message}`;
      } catch {
        /* keep the raw slice */
      }
      throw new LlmTransportError(scrub(`Anthropic API ${res.status}: ${detail}`), res.status, FATAL_STATUS.has(res.status));
    }
    let json: { content?: Array<{ type: string; text?: string }>; stop_reason?: string | null; usage?: Record<string, number | undefined> };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      throw new LlmTransportError("Anthropic API answered 2xx with a body that is not JSON", res.status, false);
    }
    const u = json.usage ?? {};
    return {
      text: (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
      stopReason: json.stop_reason ?? null,
      usage: {
        input_tokens: u["input_tokens"] ?? 0,
        output_tokens: u["output_tokens"] ?? 0,
        cache_creation_input_tokens: u["cache_creation_input_tokens"] ?? 0,
        cache_read_input_tokens: u["cache_read_input_tokens"] ?? 0,
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------- fake

export type QaFakeResponder = (req: QaRequest, callIndex: number) => string | Partial<LlmResponse> | Error;

/**
 * Test transport: no network, no key. Records every request in `calls`; `respond` scripts the answer (a string, a
 * partial response, or an Error to throw). Usage is simulated at 4 characters per token; the system prompt is billed as
 * a cache write on the first call and as a cache read afterwards, a block marked `cache` likewise (first sight of its
 * text = write, later = read), which is what makes the cost of the page prefix visible in tests.
 */
export class QaFakeTransport implements QaTransport {
  readonly provider = "fake";
  readonly calls: QaRequest[] = [];
  ready = true;
  private readonly seen = new Set<string>();

  constructor(private readonly respond: QaFakeResponder) {}

  assertReady(): void {
    if (!this.ready) throw new Error("fake transport is not ready");
  }

  complete(req: QaRequest): Promise<LlmResponse> {
    const i = this.calls.length;
    this.calls.push(req);
    try {
      const r = this.respond(req, i);
      if (r instanceof Error) return Promise.reject(r);
      const partial: Partial<LlmResponse> = typeof r === "string" ? { text: r } : r;
      const text = partial.text ?? "";
      const tok = (n: number): number => Math.ceil(n / 4);
      let write = 0;
      let read = 0;
      let plain = 0;
      const mark = (s: string, chars: number): void => {
        if (this.seen.has(s)) read += tok(chars);
        else {
          this.seen.add(s);
          write += tok(chars);
        }
      };
      mark(`sys:${req.system}`, req.system.length);
      for (const m of req.messages) {
        if (typeof m.content === "string") plain += tok(m.content.length);
        else for (const b of m.content) (b.cache ? mark(`blk:${b.text}`, b.text.length) : (plain += tok(b.text.length)));
      }
      const usage: LlmUsage = partial.usage ?? { input_tokens: plain, output_tokens: tok(text.length), cache_creation_input_tokens: write, cache_read_input_tokens: read };
      return Promise.resolve({ text, stopReason: partial.stopReason ?? "end_turn", usage });
    } catch (e) {
      return Promise.reject(e);
    }
  }
}

/** Builds the transport on first use, so dry runs and fully cached runs never need a key. */
export class LazyQaTransport implements QaTransport {
  private inner: QaTransport | undefined;
  constructor(
    readonly provider: string,
    private readonly make: () => QaTransport,
  ) {}
  private get t(): QaTransport {
    return (this.inner ??= this.make());
  }
  assertReady(): void {
    this.t.assertReady?.();
  }
  complete(req: QaRequest): Promise<LlmResponse> {
    return this.t.complete(req);
  }
}
