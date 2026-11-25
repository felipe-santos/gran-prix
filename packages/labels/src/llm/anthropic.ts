import { LlmTransportError, MissingApiKeyError, type LlmRequest, type LlmResponse, type LlmTransport } from "./types.js";

/**
 * The real transport: the Anthropic Messages API over `fetch` (no SDK dependency, so no lockfile change and
 * the request is fully visible and testable with an injected `fetch`).
 *
 *  - The key is read ONLY from `ANTHROPIC_API_KEY` (of `env`, `process.env` by default), at call time, held in a
 *    private field, sent only in the `x-api-key` header, and scrubbed from every error text. It is never logged,
 *    never serialised (`toJSON`), never part of a request body, an artifact or a cache record.
 *  - The fixed system prompt carries `cache_control: ephemeral` (prompt caching): the guide is paid once per
 *    cache window, and `usage` reports `cache_creation_input_tokens` / `cache_read_input_tokens` separately.
 *  - Structured output: `output_config.format = json_schema`. No forced `tool_choice` (newer models reject it).
 *  - `temperature: 0` is sent unless the request leaves it out (models that reject sampling parameters).
 *  - NOT retried here: a retry is a second paid call and must go through the ledger (the labeler owns it).
 */

export const ANTHROPIC_API_VERSION = "2023-06-01";
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface AnthropicTransportOptions {
  /** Where the key is looked up. Default `process.env`. Only `ANTHROPIC_API_KEY` is read. */
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

const FATAL_STATUS = new Set([400, 401, 403, 404]);

export class AnthropicTransport implements LlmTransport {
  readonly provider = "anthropic";
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(opts: AnthropicTransportOptions = {}) {
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

  /** Never exposes the key. */
  toJSON(): { provider: string } {
    return { provider: this.provider };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const key = this.#key();
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      output_config: { format: { type: "json_schema", schema: req.schema } },
    };
    if (req.temperature !== undefined) body["temperature"] = req.temperature;
    const scrub = (s: string): string => s.split(key).join("[redacted]");
    let res: Awaited<ReturnType<FetchLike>>;
    let text: string;
    try {
      res = await this.#fetch(`${this.#baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_API_VERSION },
        body: JSON.stringify(body),
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
