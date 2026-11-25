import { THREE_CLASS_SPACE, validate } from "@gran-prix/contracts";
import { afterAll, describe, expect, it } from "vitest";
import {
  FakeTransport,
  FsLlmCache,
  MemoryLlmCache,
  blockLines,
  defaultFakeAnswer,
  labelPagesWithLlm,
  type LlmRunConfig,
  type LlmRuntime,
  type PageJob,
} from "../src/index.js";
import { PRICES, TestLedger, cleanup, config, job, tmp } from "./llm-helpers.js";

afterAll(cleanup);

const MAIN = THREE_CLASS_SPACE.classes.indexOf("main");
const NOISE = THREE_CLASS_SPACE.classes.indexOf("noise");
const answer = (userMessage: string, over: Record<string, Partial<{ c: string; u: boolean; m: boolean }>> = {}): string =>
  JSON.stringify({ labels: blockLines(userMessage).map((b) => ({ id: b.id, c: "M", u: false, m: false, ...over[b.id] })) });

/** Output tokens that make a call cost `usd` at PRICES (input and cache tokens 0). */
const outputTokensFor = (usd: number): number => Math.floor((usd * 1_000_000) / PRICES.output_usd_per_mtok);

async function worstOf(j: PageJob, cfg: LlmRunConfig): Promise<number> {
  const r = await labelPagesWithLlm([j], { ...cfg, dry_run: true }, { cache: new MemoryLlmCache() });
  return r.report.pages[0]!.est_worst_usd;
}

describe("labels from the LLM", () => {
  it("maps block ids back to nodes, is contract-valid, and records model, prompt and guide hashes", async () => {
    const j = job("a", 3);
    const t = new FakeTransport((req) => answer(req.messages[0]!.content, { n4: { c: "S", u: true }, n8: { c: "N", m: true } }));
    const ledger = new TestLedger(10);
    const cfg = config();
    const r = await labelPagesWithLlm([j], cfg, { transport: t, ledger, cache: new MemoryLlmCache() });
    const doc = r.docs[0]!;
    expect(validate("node-labels", doc).issues).toEqual([]);
    expect(doc.labeler.kind).toBe("llm");
    expect(doc.labeler.llm).toMatchObject({ model: "model-under-test", prompt_sha256: cfg.system.prompt_sha256, temperature: 0 });
    expect(doc.labeler.llm?.response_cache_keys.length).toBe(1);
    expect((doc["llm_run"] as { guide_sha256: string }).guide_sha256).toBe(cfg.system.guide_sha256);
    expect(doc.items.every((i) => i.source === "llm")).toBe(true);
    expect(doc.items.map((i) => i.unit_id)).toEqual(j.units);
    const by = new Map(doc.items.map((i) => [i.unit_id, i]));
    expect(by.get(3)).toMatchObject({ y: MAIN, confidence: 0.8, reason: "llm:M" });
    expect(by.get(4)).toMatchObject({ y: 1, confidence: 0.5, reason: "llm:S,doubt" });
    expect(by.get(8)).toMatchObject({ y: NOISE, reason: "llm:N,mixed" });
    expect(doc.coverage).toEqual({ n_labeled: j.units.length, n_candidates: j.units.length });
    expect(t.calls[0]!.temperature).toBe(0);
    expect(t.calls[0]!.system).toBe(cfg.system.system);
  });

  it("labels the units as `collapsed` when the snapshot says they sit in a disclosure", async () => {
    const j = job("d", 1);
    (j.snapshot.nodes[4] as { flags: { disclosure?: boolean } }).flags.disclosure = true;
    const r = await labelPagesWithLlm([j], config(), { transport: new FakeTransport(), ledger: new TestLedger(10), cache: new MemoryLlmCache() });
    expect(r.docs[0]!.items.find((i) => i.unit_id === 4)?.reason).toMatch(/collapsed/);
  });

  it("retries ONCE with a correction message when ids are unknown or missing, then accepts a fixed answer", async () => {
    const t = new FakeTransport((req, i) => {
      if (i === 0) return JSON.stringify({ labels: [{ id: "n999", c: "M", u: false, m: false }] });
      return defaultFakeAnswer(req.messages[0]!.content);
    });
    const ledger = new TestLedger(10);
    const r = await labelPagesWithLlm([job("a")], config(), { transport: t, ledger, cache: new MemoryLlmCache() });
    expect(t.calls.length).toBe(2);
    const second = t.calls[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second[2]!.content).toMatch(/not asked: n999.*no answer/);
    expect(r.report.pages[0]!.status).toBe("ok");
    expect(r.docs[0]!.items.length).toBe(job("a").units.length);
    expect(ledger.count("reserve")).toBe(2);
    expect(ledger.count("commit")).toBe(2);
  });

  it("marks the page failed (no labels, never guessed) when the retry is also bad, and goes on with the next page", async () => {
    const t = new FakeTransport((req, i) => (i < 2 ? "not json at all" : defaultFakeAnswer(req.messages[0]!.content)));
    const r = await labelPagesWithLlm([job("bad"), job("good")], config(), { transport: t, ledger: new TestLedger(10), cache: new MemoryLlmCache() });
    expect(t.calls.length).toBe(3); // 2 for the bad page (1 retry, no more), 1 for the good one
    expect(r.report.pages.map((p) => p.status)).toEqual(["failed", "ok"]);
    expect(r.docs[0]!.items).toEqual([]);
    expect((r.docs[0]!["llm_run"] as { status: string; error: string }).status).toBe("failed");
    expect(validate("node-labels", r.docs[0]!).issues).toEqual([]);
    expect(r.docs[1]!.items.length).toBeGreaterThan(0);
  });

  it("leave_unlabeled: ids still missing after the retry stay unlabeled instead of failing the page", async () => {
    const partial = (req: { messages: Array<{ content: string }> }): string => {
      const full = JSON.parse(defaultFakeAnswer(req.messages[0]!.content)) as { labels: unknown[] };
      return JSON.stringify({ labels: full.labels.slice(1) });
    };
    const j = job("a");
    const failing = await labelPagesWithLlm([j], config(), { transport: new FakeTransport(partial), ledger: new TestLedger(10), cache: new MemoryLlmCache() });
    expect(failing.report.pages[0]!.status).toBe("failed");
    const lenient = await labelPagesWithLlm([j], config({ on_missing: "leave_unlabeled" }), { transport: new FakeTransport(partial), ledger: new TestLedger(10), cache: new MemoryLlmCache() });
    expect(lenient.report.pages[0]!.status).toBe("ok");
    expect(lenient.docs[0]!.items.length).toBe(j.units.length - 1);
    expect(lenient.docs[0]!["llm_run"]).toMatchObject({ unlabeled_missing_ids: 1 });
  });

  it("an API error that is not fatal fails the page without a charge; a fatal one aborts the run", async () => {
    const { LlmTransportError } = await import("../src/index.js");
    const ledger = new TestLedger(10);
    const soft = new FakeTransport(() => new LlmTransportError("429 slow down", 429, false));
    const r = await labelPagesWithLlm([job("a")], config(), { transport: soft, ledger, cache: new MemoryLlmCache() });
    expect(r.report.pages[0]!.status).toBe("failed");
    expect(ledger.count("release")).toBe(1);
    expect(ledger.spent()).toBe(0);
    const hard = new FakeTransport(() => new LlmTransportError("401 bad key", 401, true));
    await expect(labelPagesWithLlm([job("a")], config(), { transport: hard, ledger, cache: new MemoryLlmCache() })).rejects.toThrow(/401/);
  });

  it("never sends a private category (logged_in) to the model", async () => {
    const t = new FakeTransport();
    const r = await labelPagesWithLlm([job("priv", 2, [], { category: "logged_in" })], config(), { transport: t, ledger: new TestLedger(10), cache: new MemoryLlmCache() });
    expect(t.calls.length).toBe(0);
    expect(r.report.pages[0]!.status).toBe("skipped_private");
  });
});

describe("cost control", () => {
  it("reserves the worst case BEFORE each call and commits the actual cost after it", async () => {
    const ledger = new TestLedger(10);
    const order: string[] = [];
    const t = new FakeTransport((req) => {
      order.push(`call after ${ledger.events.map((e) => e.event).join(",")}`);
      return defaultFakeAnswer(req.messages[0]!.content);
    });
    const cfg = config();
    await labelPagesWithLlm([job("a")], cfg, { transport: t, ledger, cache: new MemoryLlmCache() });
    expect(order).toEqual(["call after reserve"]);
    const [res, com] = ledger.events;
    expect(res!.event).toBe("reserve");
    expect(com!.event).toBe("commit");
    expect(res!.usd).toBeGreaterThan(com!.usd); // worst case is above the real cost
    expect(com!.usd).toBeGreaterThan(0);
  });

  it("stops cleanly when the ledger refuses: finished pages are kept, the rest is reported, nothing overspends", async () => {
    const jobs = [job("A"), job("B"), job("C")];
    const worst = await worstOf(jobs[0]!, config());
    const ledger = new TestLedger(worst * 1.3);
    const t = new FakeTransport((req) => ({ text: answer(req.messages[0]!.content), usage: { input_tokens: 0, output_tokens: outputTokensFor(worst * 0.9), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
    const r = await labelPagesWithLlm(jobs, config(), { transport: t, ledger, cache: new MemoryLlmCache() });
    expect(r.report.pages.map((p) => p.status)).toEqual(["ok", "budget_stopped", "not_run"]);
    expect(r.docs.length).toBe(1);
    expect(r.docs[0]!.items.length).toBeGreaterThan(0);
    expect(r.budgetStop?.page).toBe(jobs[1]!.name);
    expect(t.calls.length).toBe(1);
    expect(ledger.spent()).toBeLessThanOrEqual(ledger.capUSD);
  });

  it("with a $0 cap no call is ever made", async () => {
    const t = new FakeTransport();
    const r = await labelPagesWithLlm([job("a")], config(), { transport: t, ledger: new TestLedger(0), cache: new MemoryLlmCache() });
    expect(t.calls.length).toBe(0);
    expect(r.budgetStop).not.toBeNull();
    expect(r.docs.length).toBe(0);
  });

  it("a budget stop between the first answer and its retry resumes later at the retry only (the first call is never paid twice)", async () => {
    const j = job("A");
    const cache = new FsLlmCache(tmp());
    const worst = await worstOf(j, config());
    const bad = (usd: number) => ({ text: "garbage", usage: { input_tokens: 0, output_tokens: outputTokensFor(usd), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
    const t1 = new FakeTransport(() => bad(worst * 0.9));
    const l1 = new TestLedger(worst * 1.3);
    const r1 = await labelPagesWithLlm([j], config(), { transport: t1, ledger: l1, cache });
    expect(t1.calls.length).toBe(1);
    expect(r1.report.pages[0]!.status).toBe("budget_stopped");
    const t2 = new FakeTransport((req) => defaultFakeAnswer(req.messages[0]!.content));
    const r2 = await labelPagesWithLlm([j], config(), { transport: t2, ledger: new TestLedger(10), cache });
    expect(t2.calls.length).toBe(1);
    expect(t2.calls[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(t2.calls[0]!.messages[1]!.content).toBe("garbage");
    expect(r2.report.pages[0]!.status).toBe("ok");
  });
});

describe("content-hash cache", () => {
  it("a second run is a 100% cache hit: no transport call, no ledger entry, identical labels", async () => {
    const jobs = [job("A"), job("B", 5)];
    const cache = new FsLlmCache(tmp());
    const t1 = new FakeTransport();
    const l1 = new TestLedger(10);
    const first = await labelPagesWithLlm(jobs, config(), { transport: t1, ledger: l1, cache });
    expect(t1.calls.length).toBe(2);
    const t2 = new FakeTransport();
    const l2 = new TestLedger(0);
    const second = await labelPagesWithLlm(jobs, config(), { transport: t2, ledger: l2, cache });
    expect(t2.calls.length).toBe(0);
    expect(l2.events).toEqual([]);
    expect(second.report.totals).toMatchObject({ calls: 0, cache_hits: 2, chunks: 2, spent_usd: 0 });
    expect(second.docs.map((d) => d.labels_id)).toEqual(first.docs.map((d) => d.labels_id));
  });

  it("a changed model, prompt or page text is a different key (no stale hit); a failed outcome is cached too", async () => {
    const j = job("A");
    const cache = new MemoryLlmCache();
    await labelPagesWithLlm([j], config(), { transport: new FakeTransport(), ledger: new TestLedger(10), cache });
    const other = new FakeTransport();
    await labelPagesWithLlm([j], config({ model: "another-model" }), { transport: other, ledger: new TestLedger(10), cache });
    expect(other.calls.length).toBe(1);
    const edited = job("A");
    (edited.snapshot.nodes[4] as { own_text: string }).own_text = "different text";
    const t3 = new FakeTransport();
    await labelPagesWithLlm([edited], config(), { transport: t3, ledger: new TestLedger(10), cache });
    expect(t3.calls.length).toBe(1);

    const failCache = new MemoryLlmCache();
    const bad = new FakeTransport(() => "nope");
    await labelPagesWithLlm([j], config(), { transport: bad, ledger: new TestLedger(10), cache: failCache });
    const again = new FakeTransport();
    const r = await labelPagesWithLlm([j], config(), { transport: again, ledger: new TestLedger(10), cache: failCache });
    expect(again.calls.length).toBe(0);
    expect(r.report.pages[0]!.status).toBe("failed");
    const retried = await labelPagesWithLlm([j], config({ retry_failed: true }), { transport: again, ledger: new TestLedger(10), cache: failCache });
    expect(again.calls.length).toBe(1);
    expect(retried.report.pages[0]!.status).toBe("ok");
  });
});

describe("dry run", () => {
  it("plans pages, blocks, tokens, cost and cache hits, and spends and calls nothing", async () => {
    const cache = new MemoryLlmCache();
    const jobs = [job("A", 3), job("B", 6)];
    // warm the cache for page A so the plan shows a hit
    await labelPagesWithLlm([jobs[0]!], config(), { transport: new FakeTransport(), ledger: new TestLedger(10), cache });
    const t = new FakeTransport();
    const ledger = new TestLedger(10);
    const log: string[] = [];
    const rt: LlmRuntime = { transport: t, ledger, cache, log: (m) => log.push(m) };
    const r = await labelPagesWithLlm(jobs, config({ dry_run: true }), rt);
    expect(t.calls.length).toBe(0);
    expect(ledger.events).toEqual([]);
    expect(r.report.dry_run).toBe(true);
    expect(r.report.pages.map((p) => p.status)).toEqual(["dry_run", "dry_run"]);
    expect(r.report.pages[0]).toMatchObject({ cache_hits: 1, est_input_tokens: 0, est_worst_usd: 0 }); // nothing left to pay on A
    expect(r.report.pages[1]!.cache_hits).toBe(0);
    expect(r.report.totals.est_input_tokens).toBeGreaterThan(1);
    expect(r.report.totals.est_worst_usd).toBeGreaterThan(r.report.totals.est_expected_usd);
    expect(r.report.totals.spent_usd).toBe(0);
    expect(r.docs.every((d) => d.items.length === 0 && (d["llm_run"] as { status: string }).status === "dry_run")).toBe(true);
    expect(log.length).toBe(2);
    expect(log[1]).toMatch(/blocks routed.*1 chunk.*0 cache hit.*est \$/);
  });

  it("needs neither a transport nor a ledger", async () => {
    const r = await labelPagesWithLlm([job("A")], config({ dry_run: true }), { cache: new MemoryLlmCache() });
    expect(r.report.pages[0]!.status).toBe("dry_run");
  });
});
