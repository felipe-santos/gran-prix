// Current models (2026-11): sampling, thinking and effort are validated per model BEFORE any call; the body that
// goes out carries thinking/effort; the ledger reserve covers the thinking headroom; the cost uses the cache prices.
// No network, no key: FakeTransport, and AnthropicTransport with an injected fetch.
import { afterAll, describe, expect, it } from "vitest";
import {
  AnthropicTransport,
  FakeTransport,
  MODEL_RULES,
  MemoryLlmCache,
  ModelParamsError,
  assertPrices,
  buildMessagesBody,
  estimateCall,
  labelPagesWithLlm,
  outputContractOf,
  planChunk,
  usageCostUSD,
  validateModelParams,
  type Effort,
  type LlmRequest,
  type PriceTable,
  type ThinkingMode,
} from "../src/index.js";
import { buildBlocks, chunkBlocks } from "../src/index.js";
import { TestLedger, cleanup, config, job } from "./llm-helpers.js";

afterAll(cleanup);

const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
const HAIKU = "claude-haiku-5-5";
const MODELS = [SONNET, OPUS, HAIKU] as const;
const THINKINGS: ThinkingMode[] = ["model-default", "off"];
const EFFORTS: Array<Effort | undefined> = [undefined, "low", "medium", "high"];

const REQ = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  model: SONNET,
  system: "SYS",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 100,
  schema: { type: "object" },
  ...over,
});

describe("validation per model (fails before any call)", () => {
  it("accepts every model x thinking x effort without temperature, except thinking off on Opus 5.5", () => {
    for (const model of MODELS) {
      for (const thinking of THINKINGS) {
        for (const effort of EFFORTS) {
          const run = (): void => validateModelParams({ model, temperature_sent: false, thinking, effort });
          if (model === OPUS && thinking === "off") expect(run, `${model} ${thinking}`).toThrow(/always thinks/);
          else expect(run, `${model} ${thinking} ${String(effort)}`).not.toThrow();
        }
      }
    }
  });

  it("refuses temperature on Sonnet 5.5, Opus 5.5 and Haiku 5.5, with a message that names the fix", () => {
    for (const model of MODELS) {
      for (const thinking of THINKINGS) {
        expect(() => validateModelParams({ model, temperature_sent: true, thinking }), model).toThrow(ModelParamsError);
        expect(() => validateModelParams({ model, temperature_sent: true, thinking }), model).toThrow(/send_temperature to false/);
      }
    }
  });

  it("accepts a dated snapshot id as the same model, and unknown models only in their plain form", () => {
    expect(() => validateModelParams({ model: "claude-sonnet-5-5-20261101", temperature_sent: true })).toThrow(/rejects the temperature/);
    expect(() => validateModelParams({ model: "some-future-model", temperature_sent: true })).not.toThrow();
    expect(() => validateModelParams({ model: "some-future-model", temperature_sent: false, thinking: "off" })).toThrow(/not in the validated table/);
    expect(() => validateModelParams({ model: "some-future-model", temperature_sent: false, effort: "low" })).toThrow(/not in the validated table/);
  });

  it("rejects values outside the enums", () => {
    expect(() => validateModelParams({ model: SONNET, temperature_sent: false, effort: "max" as Effort })).toThrow(/effort must be/);
    expect(() => validateModelParams({ model: SONNET, temperature_sent: false, thinking: "disabled" as ThinkingMode })).toThrow(/thinking must be/);
  });

  it("the run refuses a bad combination BEFORE the ledger is touched or a call is made (also on a dry run)", async () => {
    const ledger = new TestLedger(10);
    const t = new FakeTransport();
    for (const dry_run of [false, true]) {
      const cfg = config({ model: OPUS, send_temperature: true, dry_run });
      await expect(labelPagesWithLlm([job("a")], cfg, { transport: t, ledger, cache: new MemoryLlmCache() })).rejects.toThrow(/opus-5-5 rejects the temperature/);
    }
    const off = config({ model: OPUS, send_temperature: false, thinking: "off" });
    await expect(labelPagesWithLlm([job("a")], off, { transport: t, ledger, cache: new MemoryLlmCache() })).rejects.toThrow(/always thinks/);
    expect(t.calls).toHaveLength(0);
    expect(ledger.events).toHaveLength(0);
  });

  it("the transport also refuses (fatal error, no fetch) when it is handed a bad request", async () => {
    let fetched = 0;
    const t = new AnthropicTransport({
      env: { ANTHROPIC_API_KEY: "sk-test-not-real" },
      fetch: () => {
        fetched++;
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("{}") });
      },
    });
    await expect(t.complete(REQ({ model: OPUS, temperature: 0 }))).rejects.toMatchObject({ fatal: true, message: expect.stringMatching(/temperature/) as string });
    expect(fetched).toBe(0);
  });
});

describe("the body of the request, per combination", () => {
  it("omits thinking for model-default, sends the model's off form for off, and sets output_config.effort", () => {
    const thinkingOf = (model: string, thinking: ThinkingMode): unknown => buildMessagesBody(REQ({ model, thinking }))["thinking"];
    expect(thinkingOf(SONNET, "model-default")).toBeUndefined();
    expect(thinkingOf(OPUS, "model-default")).toBeUndefined();
    expect(thinkingOf(HAIKU, "model-default")).toBeUndefined();
    // between_tools: no other field in the object (display / budget_tokens next to it is a 400).
    expect(thinkingOf(SONNET, "off")).toEqual({ type: "between_tools" });
    expect(Object.keys(thinkingOf(SONNET, "off") as object)).toEqual(["type"]);
    expect(thinkingOf(HAIKU, "off")).toEqual({ type: "disabled" });
    expect(() => thinkingOf(OPUS, "off")).toThrow(/always thinks/);
  });

  it("covers the whole grid: temperature is never in the body of these models, effort only when set, format always", () => {
    let n = 0;
    for (const model of MODELS) {
      for (const thinking of THINKINGS) {
        for (const effort of EFFORTS) {
          if (model === OPUS && thinking === "off") continue;
          const body = buildMessagesBody(REQ({ model, thinking, ...(effort ? { effort } : {}) }));
          n++;
          expect(body, `${model}/${thinking}/${String(effort)}`).not.toHaveProperty("temperature");
          expect(body["output_config"]).toEqual({ format: { type: "json_schema", schema: { type: "object" } }, ...(effort ? { effort } : {}) });
          expect(body["model"]).toBe(model);
          expect(body["system"]).toEqual([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
          expect(body).not.toHaveProperty("tool_choice");
          expect(body).not.toHaveProperty("budget_tokens");
        }
      }
    }
    expect(n).toBe(3 * 2 * 4 - 4);
  });

  it("an unknown model keeps the old body: temperature 0 when asked, nothing else", () => {
    const body = buildMessagesBody(REQ({ model: "m-1", temperature: 0 }));
    expect(body["temperature"]).toBe(0);
    expect(body).not.toHaveProperty("thinking");
    expect(body["output_config"]).toEqual({ format: { type: "json_schema", schema: { type: "object" } } });
  });

  it("goes through the real transport with an injected fetch, byte for byte", async () => {
    const seen: string[] = [];
    const t = new AnthropicTransport({
      env: { ANTHROPIC_API_KEY: "sk-test-not-real" },
      fetch: (_u, init) => {
        seen.push(init.body);
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 } })) });
      },
    });
    await t.complete(REQ({ thinking: "off", effort: "low" }));
    const body = JSON.parse(seen[0]!) as Record<string, unknown>;
    expect(body["thinking"]).toEqual({ type: "between_tools" });
    expect((body["output_config"] as { effort: string }).effort).toBe("low");
    expect(body).not.toHaveProperty("temperature");
  });
});

describe("what the labeler sends and records", () => {
  it("passes thinking and effort to the transport (no temperature), and records them in the labels", async () => {
    const t = new FakeTransport();
    const cfg = config({ model: SONNET, send_temperature: false, thinking: "off", effort: "low", thinking_headroom_tokens: 0 });
    const r = await labelPagesWithLlm([job("a")], cfg, { transport: t, ledger: new TestLedger(10), cache: new MemoryLlmCache() });
    expect(t.calls[0]).toMatchObject({ model: SONNET, thinking: "off", effort: "low" });
    expect(t.calls[0]).not.toHaveProperty("temperature");
    const doc = r.docs[0]!;
    expect(doc["llm_run"]).toMatchObject({ temperature_sent: false, thinking: "off", effort: "low" });
    // the labeler params are hashed into params_sha256: another effort is another labeler.
    const other = await labelPagesWithLlm([job("a")], { ...cfg, effort: "high" }, { transport: new FakeTransport(), ledger: new TestLedger(10), cache: new MemoryLlmCache() });
    expect(other.docs[0]!.labeler.params_sha256).not.toBe(doc.labeler.params_sha256);
  });

  it("the default request records model-default and a null effort, and leaves the fields out of the request", async () => {
    const t = new FakeTransport();
    const r = await labelPagesWithLlm([job("a")], config({ send_temperature: true }), { transport: t, ledger: new TestLedger(10), cache: new MemoryLlmCache() });
    expect(t.calls[0]).not.toHaveProperty("thinking");
    expect(t.calls[0]).not.toHaveProperty("effort");
    expect(r.docs[0]!["llm_run"]).toMatchObject({ thinking: "model-default", effort: null });
  });

  it("thinking and effort enter the cache key; the default request keeps the bare output contract", () => {
    const cache = new MemoryLlmCache();
    const j = job("a", 4);
    const chunk = chunkBlocks(buildBlocks(j.snapshot, j.units), new Set(j.units), 400, 10)[0]!;
    const header = { title: "T", category: "article" };
    const key = (over: Partial<ReturnType<typeof config>>): string => planChunk(header, chunk, config({ model: SONNET, send_temperature: false, ...over }), cache).key;
    const keys = new Set([key({}), key({ thinking: "off" }), key({ effort: "low" }), key({ effort: "high" }), key({ thinking: "off", effort: "low" })]);
    expect(keys.size).toBe(5);
    expect(outputContractOf({})).toBe("block_labels_mcn@1");
    expect(outputContractOf({ thinking: "model-default" })).toBe("block_labels_mcn@1");
    expect(outputContractOf({ thinking: "off", effort: "low" })).toBe("block_labels_mcn@1+thinking=off+effort=low");
  });

  it("max_tokens carries the thinking headroom, and the reserve of the ledger covers it", async () => {
    const run = async (headroom: number) => {
      const t = new FakeTransport();
      const ledger = new TestLedger(100);
      const cfg = config({ model: OPUS, send_temperature: false, thinking_headroom_tokens: headroom, max_output_tokens: 100_000 });
      await labelPagesWithLlm([job("a", 3)], cfg, { transport: t, ledger, cache: new MemoryLlmCache() });
      return { maxTokens: t.calls[0]!.maxTokens, reserved: ledger.events.find((e) => e.event === "reserve")!.usd, prices: cfg.prices };
    };
    const base = await run(0);
    const withThinking = await run(8000);
    expect(withThinking.maxTokens).toBe(base.maxTokens + 8000);
    // every extra max_tokens token is reserved at the OUTPUT price (thinking is billed as output).
    expect(withThinking.reserved - base.reserved).toBeCloseTo((8000 * withThinking.prices.output_usd_per_mtok) / 1_000_000, 9);
  });
});

describe("price with cache", () => {
  const SONNET_PRICES: PriceTable = MODEL_RULES[SONNET]!.prices;

  it("carries the tabled prices of the three models (2026-11)", () => {
    expect(MODEL_RULES[SONNET]!.prices).toEqual({ input_usd_per_mtok: 2, output_usd_per_mtok: 10, cache_write_usd_per_mtok: 2.5, cache_read_usd_per_mtok: 0.1 });
    expect(MODEL_RULES[OPUS]!.prices).toEqual({ input_usd_per_mtok: 4, output_usd_per_mtok: 20, cache_write_usd_per_mtok: 5, cache_read_usd_per_mtok: 0.2 });
    expect(MODEL_RULES[HAIKU]!.prices).toMatchObject({ input_usd_per_mtok: 0.1, output_usd_per_mtok: 0.5, cache_write_usd_per_mtok: 0.125 });
    for (const m of MODELS) expect(() => assertPrices(MODEL_RULES[m]!.prices)).not.toThrow();
  });

  it("charges cache creation and cache read at their own prices, not at the input price", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 500_000, cache_creation_input_tokens: 2_000_000, cache_read_input_tokens: 4_000_000 };
    // 1 x 2 + 2 x 2.5 + 4 x 0.1 + 0.5 x 10 = 2 + 5 + 0.4 + 5
    expect(usageCostUSD(usage, SONNET_PRICES)).toBeCloseTo(12.4, 9);
    // without explicit cache prices: write 1.25x and read 0.1x of the input price
    const bare: PriceTable = { input_usd_per_mtok: 2, output_usd_per_mtok: 10 };
    expect(usageCostUSD(usage, bare)).toBeCloseTo(2 + 5 + 0.8 + 5, 9);
    // Opus 5.5: 4 + 2 x 5 + 4 x 0.2 + 0.5 x 20
    expect(usageCostUSD(usage, MODEL_RULES[OPUS]!.prices)).toBeCloseTo(4 + 10 + 0.8 + 10, 9);
  });

  it("the commit to the ledger is the real usage cost with cache tokens", async () => {
    const t = new FakeTransport((req) => ({
      text: JSON.stringify({ labels: [...req.messages[0]!.content.matchAll(/^(n\d+)\|/gm)].map((m) => ({ id: m[1], c: "M", u: false, m: false })) }),
      usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 5000 },
    }));
    const ledger = new TestLedger(10);
    const cfg = config({ model: SONNET, send_temperature: false, prices: SONNET_PRICES });
    await labelPagesWithLlm([job("a", 1)], cfg, { transport: t, ledger, cache: new MemoryLlmCache() });
    const committed = ledger.events.find((e) => e.event === "commit")!.usd;
    expect(committed).toBeCloseTo((1000 * 2 + 3000 * 2.5 + 5000 * 0.1 + 200 * 10) / 1_000_000, 12);
  });

  it("a warm cache is cheaper in the expected estimate; the worst case still assumes every input token is a write", () => {
    const e = estimateCall(30_000, 6_000, 4_000, 800, SONNET_PRICES);
    expect(e.expected_cached_usd).toBeLessThan(e.expected_usd);
    const sys = Math.ceil(30_000 / 3) + 8;
    expect(e.expected_usd - e.expected_cached_usd).toBeCloseTo((sys * (2.5 - 0.1)) / 1_000_000, 9);
    expect(e.worst_usd).toBeGreaterThan(e.expected_usd);
  });

  it("the dry run charges the system prompt as a write once, then as reads", async () => {
    const j = job("a", 6);
    const cfg = config({ model: SONNET, send_temperature: false, prices: SONNET_PRICES, chunk_blocks: 3, dry_run: true });
    const r = await labelPagesWithLlm([j], cfg, { cache: new MemoryLlmCache() });
    const p = r.report.pages[0]!;
    expect(p.chunks).toBeGreaterThan(1);
    const blocks = buildBlocks(j.snapshot, j.units);
    const chunks = chunkBlocks(blocks, new Set(j.units), 3, 10);
    const plans = chunks.map((c) => planChunk({ title: j.snapshot.page.title ?? "", category: "article" }, c, cfg, new MemoryLlmCache()));
    const want = plans.reduce((n, pl, i) => n + (i === 0 ? pl.est.expected_usd : pl.est.expected_cached_usd), 0);
    expect(p.est_expected_usd).toBeCloseTo(want, 12);
  });
});
