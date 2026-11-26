// QA tool, candidate generation: the page draw, the strict parse of the generator's answer, the generator call with the fake
// (invalid JSON gets one retry, the cache and the ledger rules), and the rejection statistics.
import { afterAll, describe, expect, it } from "vitest";
import { BudgetExceededError } from "../src/ledger.js";
import { MemoryQaCache, estimateOf, runCall } from "../src/stages/qa/call.js";
import { DEFAULT_PAGE_QUOTA, generatorPlan, rejectionStats, selectPages, validateCandidates, type PageRef } from "../src/stages/qa/generate.js";
import { CANDIDATE_KINDS, GENERATOR_PROMPT_SHA256, GENERATOR_SYSTEM, KIND_QUOTA, parseCandidates, type RawCandidate } from "../src/stages/qa/prompts.js";
import { QaFakeTransport } from "../src/stages/qa/transport.js";
import { callModel, ledgerPort } from "./qa-fixtures.js";
import { cleanupTmp } from "./helpers.js";

afterAll(cleanupTmp);

const page = (stratum: string, i: number, split: "train" | "val" | "test"): Omit<PageRef, "prediction"> => ({ group_id: `${stratum}${i}.example#${String(i).padStart(12, "0")}`, group_key: `${stratum}${i}.example`, snapshot_id: `sha256:${String(i).padStart(64, "0")}`, stratum, split });

describe("page selection (protocol 9: every test page plus dev pages to the quota, drawn by the seed)", () => {
  const pool = [
    ...Array.from({ length: 4 }, (_, i) => page("docs", i, "test")),
    ...Array.from({ length: 10 }, (_, i) => page("docs", 10 + i, i % 2 ? "train" : "val")),
    ...Array.from({ length: 3 }, (_, i) => page("article", 30 + i, "test")),
    ...Array.from({ length: 2 }, (_, i) => page("article", 40 + i, "train")),
  ];

  it("takes all the test pages first, then dev pages up to the quota, with the right predictor", () => {
    const sel = selectPages(pool, { docs: 8, article: 4 }, "20261125");
    const docs = sel.selected.filter((p) => p.stratum === "docs");
    expect(docs).toHaveLength(8);
    expect(docs.filter((p) => p.split === "test")).toHaveLength(4);
    expect(docs.filter((p) => p.prediction === "frozen_model").every((p) => p.split === "test")).toBe(true);
    expect(docs.filter((p) => p.split !== "test").every((p) => p.prediction === "oof")).toBe(true);
    expect(sel.by_stratum["docs"]).toEqual({ wanted: 8, got: 8, test: 4, dev: 4, available: 14 });
    expect(sel.by_stratum["article"]).toEqual({ wanted: 4, got: 4, test: 3, dev: 1, available: 5 });
  });

  it("a quota below the number of test pages takes only that many; a short category is reported, not padded", () => {
    const sel = selectPages(pool, { docs: 2, article: 9 }, "s");
    expect(sel.by_stratum["docs"]).toMatchObject({ got: 2, test: 2, dev: 0 });
    expect(sel.by_stratum["article"]).toMatchObject({ wanted: 9, got: 5 });
  });

  it("the draw depends on the seed and on nothing else (not on the order the pages arrive in)", () => {
    const a = selectPages(pool, { docs: 8 }, "seed-a").selected.map((p) => p.group_id);
    const b = selectPages([...pool].reverse(), { docs: 8 }, "seed-a").selected.map((p) => p.group_id);
    const c = selectPages(pool, { docs: 8 }, "seed-b").selected.map((p) => p.group_id);
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });

  it("the default quota is the protocol's (article 10, the five hard categories 18 each: 100 pages)", () => {
    expect(Object.values(DEFAULT_PAGE_QUOTA).reduce((a, b) => a + b, 0)).toBe(100);
    expect(DEFAULT_PAGE_QUOTA["article"]).toBe(10);
  });
});

describe("the generator's contract", () => {
  const good = (): RawCandidate[] => CANDIDATE_KINDS.map((kind, i) => ({ kind, question: `Question ${i}?`, answer: `a${i}`, answer_variants: [], evidence_quote: `quote number ${i}` }));
  const text = (c: unknown[]): string => JSON.stringify({ candidates: c });

  it("seven candidates in the fixed order of kinds, 2 main + 3 category + 2 support, quota 2/2/1", () => {
    expect(CANDIDATE_KINDS).toEqual(["main", "category", "main", "category", "support", "category", "support"]);
    expect(CANDIDATE_KINDS.length).toBe(7);
    expect(KIND_QUOTA).toEqual({ main: 2, category: 2, support: 1 });
    expect(GENERATOR_SYSTEM).toContain("exactly 7");
  });

  it("accepts a well-formed answer", () => {
    const r = parseCandidates(text(good()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(7);
  });

  it("rejects, with the reasons, everything it must not repair", () => {
    const bad = (mut: (c: Array<Record<string, unknown>>) => void): string => {
      const c = good() as unknown as Array<Record<string, unknown>>;
      mut(c);
      const r = parseCandidates(text(c));
      return r.ok ? "OK" : r.problem;
    };
    expect(parseCandidates("```json\n{}\n```")).toMatchObject({ ok: false });
    expect(parseCandidates('{"candidates": 3}')).toMatchObject({ ok: false });
    expect(bad((c) => c.pop())).toMatch(/6 candidates, expected 7/);
    expect(bad((c) => void (c[0]!["kind"] = "support"))).toMatch(/order requires main/);
    expect(bad((c) => void (c[1]!["answer"] = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone"))).toMatch(/21 words/);
    expect(bad((c) => void (c[2]!["question"] = "  "))).toMatch(/empty question/);
    expect(bad((c) => void (c[3]!["evidence_quote"] = ""))).toMatch(/empty evidence_quote/);
    expect(bad((c) => void (c[4]!["answer_variants"] = [3]))).toMatch(/answer_variants/);
    expect(bad((c) => void (c[5]!["extra"] = true))).toMatch(/unknown key/);
  });

  it("the generator call: invalid JSON is retried once, the answer is cached, the prompt hash is the frozen one", async () => {
    const t = new QaFakeTransport((_r, i) => (i === 0 ? "oops" : text(good())));
    const { port } = ledgerPort(10);
    const cache = new MemoryQaCache();
    const plan = generatorPlan(callModel(), "docs", "# Title\n\nbody", 4000);
    expect(plan.promptSha256).toBe(GENERATOR_PROMPT_SHA256);
    const o = await runCall(plan, { transport: t, ledger: port, cache });
    expect(o.value).toHaveLength(7);
    expect(o.attempts).toBe(2);
    expect(t.calls[0]!.system).toBe(GENERATOR_SYSTEM);
    expect(t.calls[0]!.maxTokens).toBe(4000);
    expect(JSON.stringify(t.calls[0]!.messages)).toContain("Category of the page: docs");
    const again = await runCall(plan, { transport: t, ledger: port, cache });
    expect(again.hit).toBe(true);
    expect(t.calls).toHaveLength(2);
  });

  it("the ledger refusing stops generation before any call; a dry estimate says what it would cost and what is cached", async () => {
    const cache = new MemoryQaCache();
    const plan = generatorPlan(callModel(), "docs", "x".repeat(30_000), 4000);
    const e = estimateOf(plan, cache, false, 1500);
    expect(e.hit).toBe(false);
    expect(e.worst_usd).toBeGreaterThan(e.expected_usd);
    const t = new QaFakeTransport(() => text(good()));
    await expect(runCall(plan, { transport: t, ledger: ledgerPort(0).port, cache })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(t.calls).toHaveLength(0);
    await runCall(plan, { transport: t, ledger: ledgerPort(100).port, cache });
    expect(estimateOf(plan, cache, false).hit).toBe(true);
  });
});

describe("rejection statistics", () => {
  it("counts the candidates, the rejected ones, the reasons and the kinds", () => {
    const d2 = "alpha beta gamma delta epsilon zeta eta theta";
    const raw: RawCandidate[] = CANDIDATE_KINDS.map((kind, i) => ({ kind, question: `Q${i} about something?`, answer: "gamma", answer_variants: [], evidence_quote: i === 0 ? "gamma delta epsilon" : "missing text here" }));
    const list = validateCandidates(raw, d2, [{ unit: 1, start: 0, end: d2.length }], new Map([[1, "main"]]), { min: 5, max: 100 });
    expect(list[0]!.auto.status).toBe("pass");
    expect(list.slice(1).every((c) => c.auto.status === "reject" && c.auto.reasons.includes("quote_not_found"))).toBe(true);
    const s = rejectionStats([list, list]);
    expect(s.n_candidates).toBe(14);
    expect(s.n_rejected).toBe(12);
    expect(s.rate).toBeCloseTo(12 / 14, 12);
    expect(s.by_reason["quote_not_found"]).toBe(12);
    expect(s.by_kind["main"]).toEqual({ n: 4, rejected: 2 });
    expect(rejectionStats([]).rate).toBe(0);
  });
});
