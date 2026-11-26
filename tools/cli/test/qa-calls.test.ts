// QA tool, the paid-call layer: model parameters per model, the Anthropic body, and the cache + ledger + retry rules of
// `runCall` (the labeler's pattern). No network, no key: the transport is the fake or the real one with an injected fetch.
import { afterAll, describe, expect, it } from "vitest";
import { MissingApiKeyError } from "@gran-prix/labels";
import { BudgetExceededError } from "../src/ledger.js";
import { MemoryQaCache, cacheKeyOf, estimateOf, mapPool, runCall, type CallPlan } from "../src/stages/qa/call.js";
import { paramsKeyPart, recordedParams, resolveParams, type ModelCaps } from "../src/stages/qa/model-params.js";
import { JUDGE_MAX_TOKENS, JUDGE_PROMPT_SHA256, JUDGE_SCHEMA, JUDGE_SYSTEM, judgeUser, parseVerdict, verdictCorrection } from "../src/stages/qa/prompts.js";
import { QaAnthropicTransport, QaFakeTransport } from "../src/stages/qa/transport.js";
import { callModel, ledgerPort } from "./qa-fixtures.js";
import { cleanupTmp } from "./helpers.js";

afterAll(cleanupTmp);

const plan = (user = "q1", model = callModel()): CallPlan<"correct" | "incorrect"> => ({
  model,
  system: JUDGE_SYSTEM,
  promptSha256: JUDGE_PROMPT_SHA256,
  messages: [{ role: "user", content: judgeUser(user, "a", [], "r") }],
  maxTokens: JUDGE_MAX_TOKENS,
  contract: "qa.judge@1",
  schema: JUDGE_SCHEMA,
  parse: parseVerdict,
  correction: verdictCorrection,
});

describe("model parameters, validated per model", () => {
  it("the current families reject temperature, and the choice is recorded", () => {
    const p = resolveParams("some-haiku-model");
    expect(p).toMatchObject({ send_temperature: false, thinking: "off", effort: null, thinking_wire: null });
    expect(() => resolveParams("some-haiku-model", { send_temperature: true })).toThrow(/rejects temperature/);
    expect(recordedParams(p)).toEqual({ send_temperature: false, thinking: "off", thinking_wire: "omitted", effort: null, caps_source: "family table: haiku" });
  });

  it("thinking off means between_tools where the model has it, nothing otherwise; effort only where it exists", () => {
    expect(resolveParams("x-sonnet-y").thinking_wire).toEqual({ type: "between_tools" });
    expect(resolveParams("x-opus-y", { thinking: "adaptive", effort: "low" })).toMatchObject({ thinking_wire: { type: "adaptive" }, effort: "low" });
    expect(() => resolveParams("x-haiku-y", { effort: "low" })).toThrow(/effort/);
    expect(() => resolveParams("x-haiku-y", { thinking: "adaptive" })).toThrow(/thinking/);
    expect(() => resolveParams("x-sonnet-y", { effort: "extreme" })).toThrow(/effort/);
  });

  it("an unknown family is refused unless the caller declares what it accepts; ids are never in the code", () => {
    expect(() => resolveParams("mystery-model")).toThrow(/unknown model family/);
    const caps: Record<string, ModelCaps> = { "mystery-model": { rejects_temperature: false, thinking_off_wire: "disabled", thinking_modes: ["off"], efforts: [] } };
    const p = resolveParams("mystery-model", { send_temperature: true }, caps);
    expect(p).toMatchObject({ send_temperature: true, thinking_wire: { type: "disabled" }, caps_source: 'params.capabilities["mystery-model"]' });
  });

  it("every knob that changes the request changes the cache key", () => {
    const a = paramsKeyPart(resolveParams("x-sonnet-y"));
    const b = paramsKeyPart(resolveParams("x-sonnet-y", { effort: "high" }));
    const c = paramsKeyPart(resolveParams("x-sonnet-y", { thinking: "adaptive" }));
    expect(new Set([a, b, c]).size).toBe(3);
    expect(cacheKeyOf(plan("q", callModel("x-sonnet-y")))).not.toBe(cacheKeyOf({ ...plan("q", callModel("x-sonnet-y")), model: { ...callModel("x-sonnet-y"), params: resolveParams("x-sonnet-y", { effort: "high" }) } }));
  });
});

describe("the real transport", () => {
  const SECRET = "sk-ant-api03-SENTINEL-do-not-leak-0123456789";
  const ok = { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } })) };

  it("builds the body: cache marks on blocks, effort and thinking as given, temperature only when asked", () => {
    const body = QaAnthropicTransport.body({
      model: "m",
      system: "S",
      messages: [{ role: "user", content: [{ text: "page", cache: true }, { text: "question" }] }],
      maxTokens: 200,
      thinking: { type: "between_tools" },
      effort: "low",
    });
    expect(body).toMatchObject({
      model: "m",
      max_tokens: 200,
      system: [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "page", cache_control: { type: "ephemeral" } }, { type: "text", text: "question" }] }],
      output_config: { effort: "low" },
      thinking: { type: "between_tools" },
    });
    expect(body).not.toHaveProperty("temperature");
    const plain = QaAnthropicTransport.body({ model: "m", system: "S", messages: [{ role: "user", content: "x" }], maxTokens: 5, temperature: 0, schema: { type: "object" } });
    expect(plain).toMatchObject({ temperature: 0, output_config: { format: { type: "json_schema", schema: { type: "object" } } } });
    expect(plain).not.toHaveProperty("thinking");
  });

  it("needs a key only when a call is due, sends it only in the header and scrubs it from errors", async () => {
    expect(() => new QaAnthropicTransport({ env: {} }).assertReady()).toThrow(MissingApiKeyError);
    let seen: { headers: Record<string, string>; body: string } | undefined;
    const t = new QaAnthropicTransport({ env: { ANTHROPIC_API_KEY: SECRET }, fetch: (_u, init) => ((seen = init), Promise.resolve(ok)) });
    const r = await t.complete({ model: "m", system: "S", messages: [{ role: "user", content: "x" }], maxTokens: 5 });
    expect(r.text).toBe("hi");
    expect(r.usage).toEqual({ input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    expect(seen?.headers["x-api-key"]).toBe(SECRET);
    expect(seen?.body).not.toContain(SECRET);
    expect(JSON.stringify(t)).not.toContain(SECRET);
    const bad = new QaAnthropicTransport({ env: { ANTHROPIC_API_KEY: SECRET }, fetch: () => Promise.resolve({ ok: false, status: 400, text: () => Promise.resolve(JSON.stringify({ error: { type: "invalid_request_error", message: `bad ${SECRET}` } })) }) });
    const err = await bad.complete({ model: "m", system: "S", messages: [{ role: "user", content: "x" }], maxTokens: 5 }).catch((e: Error) => e);
    expect(String(err)).toContain("400");
    expect(String(err)).not.toContain(SECRET);
    expect((err as { fatal?: boolean }).fatal).toBe(true);
  });
});

describe("runCall: cache, ledger, retry", () => {
  const verdict = (v: string): string => JSON.stringify({ verdict: v });

  it("pays once and answers the same question from the cache afterwards, with the transport untouched", async () => {
    const t = new QaFakeTransport(() => verdict("correct"));
    const { port, ledger } = ledgerPort(10);
    const cache = new MemoryQaCache();
    const a = await runCall(plan(), { transport: t, ledger: port, cache });
    expect(a).toMatchObject({ value: "correct", hit: false, calls: 1, attempts: 1 });
    expect(a.spent_usd).toBeGreaterThan(0);
    expect(ledger.spentUSD()).toBeCloseTo(a.spent_usd, 12);
    const b = await runCall(plan(), { transport: t, ledger: port, cache });
    expect(b).toMatchObject({ value: "correct", hit: true, calls: 0, spent_usd: 0 });
    expect(b.cost_usd).toBeCloseTo(a.cost_usd, 12); // the study's cost is reported, not the run's
    expect(t.calls).toHaveLength(1);
    expect(ledger.spentUSD()).toBeCloseTo(a.spent_usd, 12);
    await runCall(plan("another question"), { transport: t, ledger: port, cache });
    expect(t.calls).toHaveLength(2);
  });

  it("a fully cached run needs no transport and no ledger at all", async () => {
    const cache = new MemoryQaCache();
    await runCall(plan(), { transport: new QaFakeTransport(() => verdict("incorrect")), ledger: ledgerPort(1).port, cache });
    const again = await runCall(plan(), { cache });
    expect(again.value).toBe("incorrect");
    await expect(runCall(plan("new"), { cache })).rejects.toThrow(/no transport/);
  });

  it("invalid JSON gets exactly one correction retry; the second attempt is reserved and committed like the first", async () => {
    const t = new QaFakeTransport((_req, i) => (i === 0 ? "not json" : verdict("correct")));
    const { port, ledger } = ledgerPort(10);
    const o = await runCall(plan(), { transport: t, ledger: port, cache: new MemoryQaCache() });
    expect(o).toMatchObject({ value: "correct", attempts: 2, calls: 2 });
    expect(t.calls).toHaveLength(2);
    const second = t.calls[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(typeof second[2]!.content === "string" ? second[2]!.content : "").toMatch(/not acceptable/);
    const events = ledger.entries().map((e) => e.event);
    expect(events).toEqual(["reserve", "commit", "reserve", "commit"]);
  });

  it("invalid twice is a FAILED outcome, cached: not paid again unless retry_failed", async () => {
    const t = new QaFakeTransport(() => "still not json");
    const { port } = ledgerPort(10);
    const cache = new MemoryQaCache();
    const a = await runCall(plan(), { transport: t, ledger: port, cache });
    expect(a.value).toBeUndefined();
    expect(a.error).toMatch(/not valid JSON/);
    expect(a.calls).toBe(2);
    const b = await runCall(plan(), { transport: t, ledger: port, cache });
    expect(b).toMatchObject({ hit: true, calls: 0 });
    expect(b.error).toBeDefined();
    expect(t.calls).toHaveLength(2);
    const c = await runCall(plan(), { transport: t, ledger: port, cache, retryFailed: true });
    expect(c.calls).toBe(2);
    expect(t.calls).toHaveLength(4);
  });

  it("the ledger refusing a reservation stops the call before the transport: nothing is spent or sent", async () => {
    const t = new QaFakeTransport(() => verdict("correct"));
    const { port, ledger } = ledgerPort(0);
    await expect(runCall(plan(), { transport: t, ledger: port, cache: new MemoryQaCache() })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(t.calls).toHaveLength(0);
    expect(ledger.spentUSD()).toBe(0);
  });

  it("a budget that stops between the first answer and its retry parks the paid answer; a later run pays only the retry", async () => {
    const cache = new MemoryQaCache();
    const probe = estimateOf(plan(), cache);
    // enough for one attempt (worst case) but not for two
    const { port, ledger } = ledgerPort(probe.worst_usd * 1.5);
    const t = new QaFakeTransport(() => "not json");
    await expect(runCall(plan(), { transport: t, ledger: port, cache })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(t.calls).toHaveLength(1);
    const key = cacheKeyOf(plan());
    expect(cache.get(key)?.status).toBe("pending_retry");
    const spentFirst = ledger.spentUSD();
    const t2 = new QaFakeTransport(() => verdict("correct"));
    const rich = ledgerPort(10);
    const o = await runCall(plan(), { transport: t2, ledger: rich.port, cache });
    expect(o).toMatchObject({ value: "correct", calls: 1, attempts: 2 });
    expect(t2.calls).toHaveLength(1);
    expect(t2.calls[0]!.messages).toHaveLength(3); // the retry carries the first answer and the correction
    expect(spentFirst).toBeGreaterThan(0);
  });

  it("a transport error releases the reservation (nothing was billed) and leaves no cache record", async () => {
    const { port, ledger } = ledgerPort(10);
    const cache = new MemoryQaCache();
    await expect(runCall(plan(), { transport: new QaFakeTransport(() => new Error("network")), ledger: port, cache })).rejects.toThrow("network");
    expect(ledger.spentUSD()).toBe(0);
    expect(cache.records.size).toBe(0);
  });
});

describe("mapPool", () => {
  it("keeps the input order whatever the concurrency, and returns the first error without starting new work", async () => {
    const r = await mapPool([1, 2, 3, 4, 5], 3, async (x) => x * 2);
    expect(r.results).toEqual([2, 4, 6, 8, 10]);
    expect(r.error).toBeUndefined();
    const started: number[] = [];
    const f = await mapPool([1, 2, 3, 4], 1, async (x) => {
      started.push(x);
      if (x === 2) throw new Error("boom");
      return x;
    });
    expect(started).toEqual([1, 2]);
    expect(f.results).toEqual([1, undefined, undefined, undefined]);
    expect((f.error as Error).message).toBe("boom");
  });
});
