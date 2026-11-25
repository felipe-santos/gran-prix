import type { LlmRequest, LlmResponse, LlmTransport, LlmUsage } from "./types.js";

/** Ids and tags of the lines under `BLOCKS` in a user message rendered by `renderUserMessage`. */
export function blockLines(userMessage: string): Array<{ id: string; tag: string; text: string }> {
  const at = userMessage.indexOf("\nBLOCKS (");
  if (at < 0) return [];
  const rows = userMessage.slice(userMessage.indexOf("\n", at + 1) + 1).split("\n");
  return rows.filter((r) => r.trim() !== "").map((r) => {
    const [id = "", tag = "", , ...rest] = r.split("|");
    return { id, tag, text: rest.join("|") };
  });
}

/** Default behavior of the fake: a plausible, deterministic answer for every block. */
export function defaultFakeAnswer(userMessage: string): string {
  const labels = blockLines(userMessage).map((b) => ({
    id: b.id,
    c: /^(h[1-6]|p|li|td|pre|blockquote)$/.test(b.tag) ? "M" : /^(time|figcaption|cite|small)$/.test(b.tag) ? "S" : "N",
    u: false,
    m: false,
  }));
  return JSON.stringify({ labels });
}

export type FakeResponder = (req: LlmRequest, callIndex: number) => string | Partial<LlmResponse> | Error;

/**
 * Test transport: no network, no key. Records every request in `calls`; `respond` scripts the answer
 * (a string = the response text, a partial response, or an Error to throw). Usage is simulated with 4 chars per
 * token, and the system prompt is billed as a cache write on the first call and a cache read afterwards.
 */
export class FakeTransport implements LlmTransport {
  readonly provider = "fake";
  readonly calls: LlmRequest[] = [];
  ready = true;

  constructor(private readonly respond: FakeResponder = (req) => defaultFakeAnswer(req.messages[0]?.content ?? "")) {}

  assertReady(): void {
    if (!this.ready) throw new Error("fake transport is not ready");
  }

  complete(req: LlmRequest): Promise<LlmResponse> {
    const i = this.calls.length;
    this.calls.push(req);
    try {
      const r = this.respond(req, i);
      if (r instanceof Error) return Promise.reject(r);
      const partial: Partial<LlmResponse> = typeof r === "string" ? { text: r } : r;
      const text = partial.text ?? "";
      const sys = Math.ceil(req.system.length / 4);
      const user = Math.ceil(req.messages.reduce((n, m) => n + m.content.length, 0) / 4);
      const usage: LlmUsage = partial.usage ?? {
        input_tokens: user,
        output_tokens: Math.ceil(text.length / 4),
        cache_creation_input_tokens: i === 0 ? sys : 0,
        cache_read_input_tokens: i === 0 ? 0 : sys,
      };
      return Promise.resolve({ text, stopReason: partial.stopReason ?? "end_turn", usage });
    } catch (e) {
      return Promise.reject(e);
    }
  }
}
