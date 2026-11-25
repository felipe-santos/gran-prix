import { describe, expect, it } from "vitest";
import {
  AnthropicTransport,
  DEFAULT_ROUTING,
  FakeTransport,
  LlmTransportError,
  MemoryLlmCache,
  MissingApiKeyError,
  labelPagesWithLlm,
  routePage,
  votersFromLabels,
  usageCostUSD,
  estimateCall,
  type LlmRequest,
} from "../src/index.js";
import { PRICES, TestLedger, articleSnapshot, config, job, layer } from "./llm-helpers.js";

// article-snapshot units for 3 paragraphs: 3 (h1), 4, 5, 6 (p), 8 (a)
const KEEP = 0; // main
const DROP = 2; // noise

describe("routing by disagreement", () => {
  const a = articleSnapshot("r", 3);
  const sid = a.snapshot.snapshot_id;
  const params = { ...DEFAULT_ROUTING, control_sample: 0 };

  it("sends units the voters disagree on, and units a voter abstained on", () => {
    const rd = layer(a.snapshot, "readability", [[3, KEEP], [4, KEEP], [5, DROP], [6, KEEP], [8, DROP]], {}, 5);
    const other = layer(a.snapshot, "heuristic", [[3, KEEP], [4, KEEP], [5, KEEP], [8, DROP]], {}, 5); // abstains on 6
    const { voters, settled } = votersFromLabels([rd, other]);
    const d = routePage(sid, a.units, voters, settled, params);
    expect(d.page_whole).toBeNull();
    expect([...d.routed]).toEqual([[5, "disagreement"], [6, "abstention"]]);
    expect(d.counts).toMatchObject({ candidates: 5, routed: 2, automatic: 3 });
  });

  it("is deterministic: same inputs, same decision, same hash; a different seed changes only the control sample", () => {
    const rd = layer(a.snapshot, "readability", a.units.map((u) => [u, KEEP] as [number, number]));
    const one = votersFromLabels([rd]);
    const s = { ...DEFAULT_ROUTING, control_sample: 0.5 };
    const d1 = routePage(sid, a.units, one.voters, one.settled, s);
    const d2 = routePage(sid, a.units, one.voters, one.settled, s);
    expect(JSON.stringify([...d1.routed])).toBe(JSON.stringify([...d2.routed]));
    expect(d1.routed_sha256).toBe(d2.routed_sha256);
    const d3 = routePage(sid, a.units, one.voters, one.settled, { ...s, seed: "another" });
    expect([...d3.routed.values()].every((r) => r === "control-sample")).toBe(true);
    expect(d1.counts.by_reason).toEqual({ "control-sample": d1.routed.size });
    // the control sample really is a fraction, not all or none, on a bigger page
    const big = articleSnapshot("big", 60);
    const bl = layer(big.snapshot, "readability", big.units.map((u) => [u, KEEP] as [number, number]));
    const v = votersFromLabels([bl]);
    const n = routePage(big.snapshot.snapshot_id, big.units, v.voters, v.settled, { ...DEFAULT_ROUTING, control_sample: 0.15 }).routed.size;
    expect(n).toBeGreaterThan(2);
    expect(n).toBeLessThan(30);
  });

  it("sends the whole page when a voter discarded its alignment, is not readerable, abstains a lot, or there is no voter", () => {
    const discarded = layer(a.snapshot, "readability", [], { alignment: { discarded: true, readerable: true } }, 5);
    let d = routePage(sid, a.units, votersFromLabels([discarded]).voters, new Set(), params);
    expect(d.page_whole).toMatch(/abstention/);
    expect(d.routed.size).toBe(5);

    const notReaderable = layer(a.snapshot, "readability", a.units.map((u) => [u, KEEP] as [number, number]), { alignment: { discarded: false, readerable: false } });
    d = routePage(sid, a.units, votersFromLabels([notReaderable]).voters, new Set(), params);
    expect(d.page_whole).toBe("not-readerable");
    expect(d.routed.size).toBe(5);
    expect([...d.routed.values()][0]).toBe("page-whole:not-readerable");

    d = routePage(sid, a.units, [], new Set(), params);
    expect(d.page_whole).toBe("no-voters");
  });

  it("never routes units a human already settled; mode all sends everything else", () => {
    const human = layer(a.snapshot, "human", [[3, KEEP], [4, KEEP]]);
    const { voters, settled } = votersFromLabels([human]);
    expect(voters.length).toBe(0);
    const d = routePage(sid, a.units, voters, settled, params);
    expect([...d.routed.keys()]).toEqual([5, 6, 8]);
    expect(d.counts.settled_by_human).toBe(2);
    const all = routePage(sid, a.units, voters, settled, { ...params, mode: "all" });
    expect([...all.routed.values()]).toEqual(["all", "all", "all"]);
  });

  it("only the routed units reach the model, and the decision is recorded in the labels", async () => {
    const j = job("r", 3, [layer(a.snapshot, "readability", [[3, KEEP], [4, KEEP], [5, DROP], [6, KEEP], [8, DROP]], {}, 5), layer(a.snapshot, "heuristic", [[3, KEEP], [4, KEEP], [5, KEEP], [6, KEEP], [8, DROP]], {}, 5)]);
    j.snapshot = a.snapshot;
    const t = new FakeTransport();
    const r = await labelPagesWithLlm([j], config({ routing: params }), { transport: t, ledger: new TestLedger(10), cache: new MemoryLlmCache() });
    expect(t.calls.length).toBe(1);
    const msg = t.calls[0]!.messages[0]!.content;
    expect(msg).toContain("BLOCKS (label every one, 1):");
    expect(r.docs[0]!.items.map((i) => i.unit_id)).toEqual([5]);
    expect(r.docs[0]!["llm_run"]).toMatchObject({ routing: { mode: "disagreement", page_whole: null, counts: { routed: 1, automatic: 4 } } });
    expect(r.report.pages[0]!.routed_unit_ids).toEqual([5]);
  });
});

const SECRET = "sk-ant-test-SECRET-0123456789";
const okBody = JSON.stringify({
  content: [{ type: "text", text: '{"labels":[]}' }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 2000, cache_read_input_tokens: 4000 },
});
const REQ: LlmRequest = { model: "m-1", system: "SYS", messages: [{ role: "user", content: "hi" }], maxTokens: 100, temperature: 0, schema: { type: "object" } };

describe("AnthropicTransport (no network: fetch is injected)", () => {
  it("sends the key only in x-api-key, caches the system prompt, asks for structured output, reads usage", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const t = new AnthropicTransport({
      env: { ANTHROPIC_API_KEY: SECRET },
      fetch: (url, init) => {
        seen.push({ url, headers: init.headers, body: init.body });
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(okBody) });
      },
    });
    const r = await t.complete(REQ);
    expect(r.usage).toEqual({ input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 2000, cache_read_input_tokens: 4000 });
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0]!.headers["x-api-key"]).toBe(SECRET);
    expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen[0]!.body).not.toContain(SECRET);
    const body = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(body["system"]).toEqual([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
    expect(body["temperature"]).toBe(0);
    expect(body["output_config"]).toEqual({ format: { type: "json_schema", schema: { type: "object" } } });
    expect(body).not.toHaveProperty("tool_choice");
    const { temperature: _t, ...noTemp } = REQ;
    await t.complete(noTemp);
    expect(JSON.parse(seen[1]!.body)).not.toHaveProperty("temperature");
  });

  it("reads ANTHROPIC_API_KEY only, fails before any request when it is missing, and never serialises the key", async () => {
    let calls = 0;
    const fetchSpy = () => {
      calls++;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(okBody) });
    };
    const none = new AnthropicTransport({ env: { SOME_OTHER_KEY: SECRET }, fetch: fetchSpy });
    expect(() => none.assertReady()).toThrow(MissingApiKeyError);
    await expect(none.complete(REQ)).rejects.toThrow(MissingApiKeyError);
    expect(calls).toBe(0);
    const t = new AnthropicTransport({ env: { ANTHROPIC_API_KEY: SECRET }, fetch: fetchSpy });
    expect(JSON.stringify(t)).not.toContain(SECRET);
    expect(String(Object.values(t))).not.toContain(SECRET);
  });

  it("turns API errors into typed errors with the key scrubbed; 4xx config errors are fatal, 429/5xx are not", async () => {
    const fail = (status: number, message: string) =>
      new AnthropicTransport({
        env: { ANTHROPIC_API_KEY: SECRET },
        fetch: () => Promise.resolve({ ok: false, status, text: () => Promise.resolve(JSON.stringify({ error: { type: "e", message } })) }),
      });
    const bad = (await fail(401, `invalid x-api-key ${SECRET}`).complete(REQ).catch((e: unknown) => e)) as LlmTransportError;
    expect(bad).toBeInstanceOf(LlmTransportError);
    expect(bad.fatal).toBe(true);
    expect(bad.message).not.toContain(SECRET);
    expect(bad.message).toContain("[redacted]");
    expect(((await fail(429, "slow").complete(REQ).catch((e: unknown) => e)) as LlmTransportError).fatal).toBe(false);
    expect(((await fail(529, "busy").complete(REQ).catch((e: unknown) => e)) as LlmTransportError).fatal).toBe(false);
    const net = new AnthropicTransport({ env: { ANTHROPIC_API_KEY: SECRET }, fetch: () => Promise.reject(new Error(`boom ${SECRET}`)) });
    const e = (await net.complete(REQ).catch((x: unknown) => x)) as LlmTransportError;
    expect(e.message).not.toContain(SECRET);
  });
});

describe("prices and cost", () => {
  it("converts usage to USD with the table that is passed in (cache write 1.25x and read 0.1x by default)", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };
    expect(usageCostUSD(usage, PRICES)).toBeCloseTo(3 + 15 + 3.75 + 0.3, 9);
    expect(usageCostUSD(usage, { ...PRICES, cache_write_usd_per_mtok: 6, cache_read_usd_per_mtok: 1 })).toBeCloseTo(3 + 15 + 6 + 1, 9);
    expect(usageCostUSD(usage, { input_usd_per_mtok: 1, output_usd_per_mtok: 5 })).toBeCloseTo(1 + 5 + 1.25 + 0.1, 9);
  });

  it("the worst case reserved is above the expected cost and grows with input and max_tokens", () => {
    const small = estimateCall(1000, 1000, 1000, 500, PRICES);
    const big = estimateCall(1000, 5000, 4000, 500, PRICES);
    expect(small.worst_usd).toBeGreaterThan(small.expected_usd);
    expect(big.worst_usd).toBeGreaterThan(small.worst_usd);
  });
});
