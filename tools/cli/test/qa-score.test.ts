// QA tool, scoring and the report: facts by string match, the rest by the judge (fake), the human sample and the agreement, the
// cut order's step 2, the retention measure, and the downstream section against hand and numpy-reference values and the contract.
import { afterAll, describe, expect, it } from "vitest";
import { assertValid, contractId, type QaTaskSet } from "@gran-prix/contracts";
import { MemoryQaCache } from "../src/stages/qa/call.js";
import { RetentionIndex } from "../src/stages/qa/arms.js";
import { JUDGE_SYSTEM } from "../src/stages/qa/prompts.js";
import { buildDownstream, closedBookAnalysis, type ArmScores } from "../src/stages/qa/report.js";
import { deterministic, scoreAnswers, stratifiedSample, keyOf, type ScoreConfig } from "../src/stages/qa/score.js";
import { QaFakeTransport, contentText } from "../src/stages/qa/transport.js";
import type { AnswerRow } from "../src/stages/qa/types.js";
import { callModel, HASH, ledgerPort, taskSet } from "./qa-fixtures.js";
import { cleanupTmp } from "./helpers.js";

afterAll(cleanupTmp);

const row = (task_id: string, arm: string, text: string, extra: Partial<AnswerRow> = {}): AnswerRow => ({ task_id, arm, text, input_tokens: 100, output_tokens: 5, cost_usd: 0.001, page_sha256: HASH("a"), ...extra });
const task = (answer: string, variants: string[] = []): QaTaskSet["tasks"][number] => taskSet([{ page: "p", stratum: "docs", answer, variants }]).tasks[0]!;

describe("what needs no model", () => {
  it("facts are decided by exact or containment match, either way", () => {
    expect(deterministic(row("t", "a", "Fifty"), task("fifty"), 5)).toEqual({ correct: true, method: "exact" });
    expect(deterministic(row("t", "a", "It costs fifty dollars."), task("fifty"), 5)).toEqual({ correct: true, method: "contains" });
    expect(deterministic(row("t", "a", "sixty"), task("fifty"), 5)).toEqual({ correct: false, method: "fact_no_match" });
    expect(deterministic(row("t", "a", "about 50 dollars"), task("fifty", ["50"]), 5)).toEqual({ correct: true, method: "contains" });
  });

  it("an empty answer, an error and NOT_FOUND are wrong without a call, also for long answers", () => {
    const long = task("it sets the maximum number of retries before the call fails and is dropped");
    expect(deterministic(row("t", "a", ""), long, 5)).toEqual({ correct: false, method: "no_response" });
    expect(deterministic(row("t", "a", "x", { error: "boom" }), long, 5)).toEqual({ correct: false, method: "no_response" });
    expect(deterministic(row("t", "a", "NOT_FOUND"), long, 5)).toEqual({ correct: false, method: "not_found" });
  });

  it("an answer that is not a fact and does not match goes to the judge; if it matches it is right without one", () => {
    const long = task("it sets the maximum number of retries before the call fails");
    expect(deterministic(row("t", "a", "It limits how many times the call is repeated"), long, 5)).toBeNull();
    expect(deterministic(row("t", "a", "It sets the maximum number of retries before the call fails, yes."), long, 5)).toEqual({ correct: true, method: "contains" });
  });
});

describe("the stratified human sample", () => {
  const judged = [
    ...Array.from({ length: 10 }, (_, i) => ({ task_id: `a${i}`, arm: "full_page", verdict: "correct" })),
    ...Array.from({ length: 3 }, (_, i) => ({ task_id: `b${i}`, arm: "full_page", verdict: "incorrect" })),
    ...Array.from({ length: 7 }, (_, i) => ({ task_id: `c${i}`, arm: "pruned_model", verdict: "correct" })),
  ];
  it("takes at least the fraction of every stratum (arm x verdict), rounded up, so at least 20% overall", () => {
    const s = stratifiedSample(judged, 0.2, "seed");
    const per = (arm: string, p: string): number => s.filter((x) => x.arm === arm && x.task_id.startsWith(p)).length;
    expect(per("full_page", "a")).toBe(2);
    expect(per("full_page", "b")).toBe(1); // ceil(0.6)
    expect(per("pruned_model", "c")).toBe(2); // ceil(1.4)
    expect(s.length / judged.length).toBeGreaterThanOrEqual(0.2);
  });
  it("is deterministic, depends on the seed, and never repeats an item", () => {
    const a = stratifiedSample(judged, 0.2, "seed");
    expect(stratifiedSample(judged, 0.2, "seed")).toEqual(a);
    expect(stratifiedSample(judged, 0.2, "other")).not.toEqual(a);
    expect(new Set(a.map((x) => keyOf(x.task_id, x.arm))).size).toBe(a.length);
  });
});

describe("the judge, the sample and the agreement (fake transport)", () => {
  const cfg = (over: Partial<ScoreConfig> = {}): ScoreConfig => ({ fact_max_words: 5, judge: callModel("test-opus-model"), concurrency: 1, dry_run: false, retry_failed: false, cut_trigger: 0.9, human_fraction: 0.2, sample_seed: "seed", ...over });
  const LONG = "it sets the maximum number of retries before the call fails";
  const ts = (): QaTaskSet => taskSet(Array.from({ length: 10 }, (_, i) => ({ page: `p${i}`, stratum: "docs", answer: LONG, question: `What does option ${i} do?` })));
  const rows = (t: QaTaskSet): AnswerRow[] => t.tasks.flatMap((x, i) => [row(x.id, "full_page", i % 2 === 0 ? "It limits how many times the call is repeated" : "It paints the page blue"), row(x.id, "pruned_model", "NOT_FOUND")]);
  /** The judge says correct when the response mentions "repeated". */
  const judge = (): QaFakeTransport => new QaFakeTransport((req) => JSON.stringify({ verdict: contentText(req.messages[0]!.content).includes("repeated") ? "correct" : "incorrect" }));

  it("only the answers a rule cannot decide reach the judge, with the key, through the fixed rubric", async () => {
    const t = ts();
    const j = judge();
    const cache = new MemoryQaCache();
    const r = await scoreAnswers(t, rows(t), undefined, cfg(), { transport: j, ledger: ledgerPort(100).port, cache });
    expect(j.calls).toHaveLength(10); // full_page answers only; NOT_FOUND needs no judge
    expect(j.calls[0]!.system).toBe(JUDGE_SYSTEM);
    expect(j.calls[0]!.maxTokens).toBeLessThan(100);
    expect(contentText(j.calls[0]!.messages[0]!.content)).toContain("answer_key");
    const s = (arm: string): boolean[] => r.scored.filter((x) => x.arm === arm).map((x) => x.correct as boolean);
    expect(s("full_page")).toEqual([true, false, true, false, true, false, true, false, true, false]);
    expect(s("pruned_model").every((c) => c === false)).toBe(true);
    expect(r.scored.filter((x) => x.arm === "pruned_model").every((x) => x.method === "not_found")).toBe(true);
    expect(r.judge).toMatchObject({ calls: 10, to_judge: 10 });
    expect(r.unresolved).toBe(0);
    // a rerun pays nothing
    const j2 = judge();
    const again = await scoreAnswers(t, rows(t), undefined, cfg(), { transport: j2, ledger: ledgerPort(100).port, cache });
    expect(j2.calls).toHaveLength(0);
    expect(again.judge).toMatchObject({ calls: 0, cache_hits: 10, spent_usd: 0 });
    expect(again.scored.map((x) => x.correct)).toEqual(r.scored.map((x) => x.correct));
  });

  it("the sample is at least 20% of the judged answers, hides the judge's verdict, and the agreement is computed against it", async () => {
    const t = ts();
    const cache = new MemoryQaCache();
    const first = await scoreAnswers(t, rows(t), undefined, cfg(), { transport: judge(), ledger: ledgerPort(100).port, cache });
    const sample = first.sample.items.filter((i) => i.role === "sample");
    expect(sample.length / 10).toBeGreaterThanOrEqual(0.2);
    expect(first.sample.items.every((i) => i.role === "sample")).toBe(true);
    expect(JSON.stringify(first.sample)).not.toMatch(/verdict/);
    expect(first.agreement).toBeNull();
    // the human agrees on all but one
    const verdicts = new Map(sample.map((i, k) => [keyOf(i.task_id, i.arm), (first.scored.find((s) => s.task_id === i.task_id && s.arm === i.arm)!.judge_verdict === "correct") !== (k === 0) ? ("correct" as const) : ("incorrect" as const)]));
    const second = await scoreAnswers(t, rows(t), { sample_id: first.sample.sample_id, verdicts }, cfg(), { transport: judge(), ledger: ledgerPort(100).port, cache });
    expect(second.agreement).toMatchObject({ n: sample.length, of: sample.length });
    expect(second.agreement!.agreement).toBeCloseTo((sample.length - 1) / sample.length, 12);
    expect(second.agreement!.disagreements).toHaveLength(1);
    // the judge's verdict stays the score
    expect(second.scored.map((s) => s.correct)).toEqual(first.scored.map((s) => s.correct));
    expect(second.judge.calls).toBe(0);
  });

  it("a human file made on another sample is refused", async () => {
    const t = ts();
    await expect(scoreAnswers(t, rows(t), { sample_id: HASH("9"), verdicts: new Map() }, cfg(), { transport: judge(), ledger: ledgerPort(100).port, cache: new MemoryQaCache() })).rejects.toThrow(/made on sample/);
  });

  it("a judge answer that stays invalid goes to the human queue, and a human verdict there IS the score", async () => {
    const t = ts();
    const bad = new QaFakeTransport(() => "no idea");
    const r = await scoreAnswers(t, rows(t).slice(0, 2), undefined, cfg(), { transport: bad, ledger: ledgerPort(100).port, cache: new MemoryQaCache() });
    expect(r.unresolved).toBe(1);
    expect(r.sample.items).toHaveLength(1);
    expect(r.sample.items[0]!.role).toBe("queue");
    const k = keyOf(r.sample.items[0]!.task_id, "full_page");
    const done = await scoreAnswers(t, rows(t).slice(0, 2), { sample_id: r.sample.sample_id, verdicts: new Map([[k, "correct" as const]]) }, cfg(), { transport: bad, ledger: ledgerPort(100).port, cache: new MemoryQaCache() });
    expect(done.unresolved).toBe(0);
    expect(done.scored.find((s) => s.arm === "full_page")).toMatchObject({ correct: true, method: "human", human_verdict: "correct" });
  });

  it("cut order, step 2: at 90% of the cap, when the judging does not fit, the judge stops and the answers go to the human queue", async () => {
    const t = ts();
    const j = judge();
    const l = ledgerPort(1);
    l.ledger.reserve(0.99).commit();
    const r = await scoreAnswers(t, rows(t), undefined, cfg(), { transport: j, ledger: l.port, cache: new MemoryQaCache() });
    expect(j.calls).toHaveLength(0);
    expect(r.cut?.step).toBe("judge_to_human");
    expect(r.cut?.reason).toMatch(/99\.0% of the cap/);
    expect(r.unresolved).toBe(10);
    expect(r.sample.items.filter((i) => i.role === "queue")).toHaveLength(10);
  });

  it("under 90% the judge is never cut, even if it would not fit: the ledger decides", async () => {
    const t = ts();
    const l = ledgerPort(1);
    l.ledger.reserve(0.5).commit();
    const r = await scoreAnswers(t, rows(t), undefined, cfg(), { transport: judge(), ledger: l.port, cache: new MemoryQaCache() });
    expect(r.cut).toBeNull();
    expect(r.unresolved).toBe(0);
  });

  it("a dry run plans the judging and calls nothing", async () => {
    const t = ts();
    const j = judge();
    const r = await scoreAnswers(t, rows(t), undefined, cfg({ dry_run: true }), { transport: j, ledger: ledgerPort(100).port, cache: new MemoryQaCache() });
    expect(j.calls).toHaveLength(0);
    expect(r.judge.to_judge).toBe(10);
    expect(r.judge.est_expected_usd).toBeGreaterThan(0);
  });

  it("answers for an unknown task, or twice for one, are errors", async () => {
    const t = ts();
    await expect(scoreAnswers(t, [row("nope", "full_page", "x")], undefined, cfg(), { cache: new MemoryQaCache() })).rejects.toThrow(/unknown task/);
    await expect(scoreAnswers(t, [row(t.tasks[0]!.id, "full_page", "NOT_FOUND"), row(t.tasks[0]!.id, "full_page", "NOT_FOUND")], undefined, cfg(), { cache: new MemoryQaCache() })).rejects.toThrow(/two answers/);
  });
});

describe("retention (M6)", () => {
  const idx = new RetentionIndex();
  const quote = "The widget costs [fifty](/buy) dollars today.";
  it("principal: the quote survives as a contiguous run of tokens, whatever the markup around it", () => {
    expect(idx.retention("# T\n\n- The widget costs [fifty](/buy) dollars today.\n- More", quote)).toMatchObject({ retained: true, token_fraction: 1 });
    expect(idx.retention("The widget costs fifty dollars today.", quote).retained).toBe(false); // the link target is part of the quote: https and path tokens are gone
    expect(idx.retention("The widget costs [fifty](/buy) and later dollars today.", quote).retained).toBe(false); // broken in the middle
  });
  it("secondary: the fraction of the quote's tokens that are present", () => {
    const r = idx.retention("The widget costs [fifty](/buy)", quote);
    expect(r.retained).toBe(false);
    expect(r.token_fraction).toBeCloseTo(5 / 7, 12); // the widget costs fifty buy of: the widget costs fifty buy dollars today
    expect(idx.retention("", quote)).toEqual({ retained: false, token_fraction: 0 });
  });
});

describe("the downstream section", () => {
  // 12 questions on 6 domains: d1, d2 are docs, d3..d6 are product
  const ts = taskSet([...["d1", "d2"].map((p) => ({ page: p, stratum: "docs", n: 2 })), ...["d3", "d4", "d5", "d6"].map((p) => ({ page: p, stratum: "product", n: 2 }))]);
  const ids = ts.tasks.map((t) => t.id);
  const arm = (bits: number[], cost = 0.001): ArmScores => ({ correct: new Map(ids.map((id, i) => [id, bits[i] as 0 | 1])), rows: ids.map((id) => row(id, "x", "", { cost_usd: cost, input_tokens: 200 })), judgeCost: new Map() });
  const FULL = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0];
  const MODEL = [1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 0]; // loses t4 (docs) and t8 (product)
  const CB = [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // answers page d1 from memory
  const build = (extra: Record<string, ArmScores> = {}): ReturnType<typeof buildDownstream> => {
    const retained = (flags: boolean[]): Map<string, { retained: boolean; token_fraction: number }> => new Map(ids.map((id, i) => [id, { retained: flags[i] as boolean, token_fraction: flags[i] ? 1 : 0.5 }]));
    return buildDownstream({
      taskSet: ts,
      arms: new Map([["full_page", arm(FULL)], ["pruned_model", arm(MODEL)], ["oracle", arm(FULL)], ["closed_book", arm(CB, 0.0005)], ...Object.entries(extra)]),
      retention: new Map([["full_page", retained(ids.map(() => true))], ["pruned_model", retained(ids.map((_, i) => i !== 3 && i !== 7))], ["oracle", retained(ids.map(() => true))]]),
      respondent: { model: "resp", prompt_sha256: HASH("d") },
      judge: { kind: "exact" },
      bootstrap: { resamples: 10_000, seed: 20261125 },
    });
  };
  const wrap = (d: ReturnType<typeof buildDownstream>["downstream"]): unknown => {
    const body = { format: "gran-prix.eval-report", format_version: "1.1.0", mode: "downstream", model_id: HASH("1"), dataset_id: HASH("2"), split: "test", threshold: 0.5, downstream: d, provenance: { produced_by: { run_id: "x", stage_id: "x", kind: "evaluate", impl: "x", params_sha256: HASH("b"), cache_key: HASH("c") }, inputs: [], pipeline_spec_id: HASH("d"), tool_versions: { gp_cli: "0", node: "0" }, created_at: "1970-01-01T00:00:00Z", duration_ms: 0 } };
    return { ...body, report_id: contractId("eval-report", body) };
  };

  it("the arms, the category arms and the paired deltas use the names the decision reads, and the report is valid", () => {
    const { downstream: d } = build();
    expect(Object.keys(d.arms).sort()).toEqual(expect.arrayContaining(["full_page", "pruned_model", "oracle", "closed_book", "full_page@docs", "full_page@product", "pruned_model@docs", "pruned_model@product"]));
    expect(d.paired_deltas.map((p) => `${p.a} vs ${p.b}`)).toEqual(expect.arrayContaining(["pruned_model vs full_page", "oracle vs full_page", "pruned_model@docs vs full_page@docs", "pruned_model@product vs full_page@product"]));
    assertValid("eval-report", wrap(d));
  });

  it("the delta is a fraction, the interval is the numpy reference's, and the p-value is McNemar's", () => {
    const { downstream: d } = build();
    const pd = (a: string, b: string): { mean_delta: number; ci95: [number, number]; p_value?: number } => d.paired_deltas.find((p) => p.a === a && p.b === b)!;
    const m = pd("pruned_model", "full_page");
    expect(m.mean_delta).toBeCloseTo(-2 / 12, 12);
    expect(m.ci95[0]).toBeCloseTo(-1 / 3, 12); // python bootstrap_ref, B = 10000, seed 20261125
    expect(m.ci95[1]).toBeCloseTo(0, 12);
    expect(m.p_value).toBeCloseTo(0.5, 12); // 2 discordant pairs, both against the model: 2 * 0.5^2
    expect(pd("oracle", "full_page")).toMatchObject({ mean_delta: 0, p_value: 1 });
    const docs = pd("pruned_model@docs", "full_page@docs");
    expect(docs.mean_delta).toBeCloseTo(-0.25, 12);
    expect(docs.ci95[0]).toBeCloseTo(-0.5, 12);
    expect(docs.ci95[1]).toBeCloseTo(0, 12);
    expect(pd("pruned_model@product", "full_page@product").mean_delta).toBeCloseTo(-1 / 8, 12);
  });

  it("the arms carry the accuracy, its interval, the tokens and the cost", () => {
    const { downstream: d } = build();
    const f = d.arms["full_page"]!;
    expect(f).toMatchObject({ n: 12, tokens_in_mean: 200 });
    expect(f.score_mean).toBeCloseTo(10 / 12, 12);
    expect(f.score_ci95[0]).toBeCloseTo(0.5, 12);
    expect(f.score_ci95[1]).toBeCloseTo(1, 12);
    expect(f.cost_usd).toBeCloseTo(0.012, 12);
    expect(d.arms["full_page@docs"]).toMatchObject({ n: 4, score_mean: 1 });
    expect(d.arms["full_page@docs"]!.score_ci95).toEqual([1, 1]);
    expect(d.arms["closed_book"]!.cost_usd).toBeCloseTo(0.006, 12);
  });

  it("evidence retention per arm and per category, with n_questions (what G3 and the eligibility read)", () => {
    const { downstream: d } = build();
    const r = d.arms["pruned_model"]!.evidence_retention!;
    expect(r.mean).toBeCloseTo(10 / 12, 12);
    expect(r.n_questions).toBe(12);
    expect(r.by_stratum).toEqual({ docs: { mean: 0.75, n_questions: 4 }, product: { mean: 0.875, n_questions: 8 } });
    expect(r.token_fraction_mean).toBeCloseTo((10 + 2 * 0.5) / 12, 12);
    expect(d.arms["full_page"]!.evidence_retention!.mean).toBe(1);
    expect(d.arms["closed_book"]!.evidence_retention).toBeUndefined();
  });

  it("closed book: pages above 30% are flagged and the arms and deltas are repeated without them", () => {
    const { downstream: d, closedBook: cb } = build();
    expect(cb!.flagged).toEqual([ts.pages[0]!.group_id]); // d1: 2 of 2 answered from memory
    expect(cb!.per_page.find((p) => p.group_id === ts.pages[1]!.group_id)!.accuracy).toBe(0);
    expect(d.arms["full_page~nocb"]).toMatchObject({ n: 10 });
    expect(d.arms["pruned_model~nocb"]).toMatchObject({ n: 10 });
    const p = d.paired_deltas.find((x) => x.a === "pruned_model~nocb" && x.b === "full_page~nocb")!;
    expect(p.mean_delta).toBeCloseTo(-2 / 10, 12);
    assertValid("eval-report", wrap(d));
  });

  it("no flagged page, no extra arms; every page flagged, none either", () => {
    const none = buildDownstream({ taskSet: ts, arms: new Map([["full_page", arm(FULL)], ["pruned_model", arm(MODEL)], ["closed_book", arm(ids.map(() => 0))]]), retention: new Map(), respondent: { model: "r", prompt_sha256: HASH("d") }, judge: { kind: "exact" }, bootstrap: { resamples: 200, seed: 1 } });
    expect(Object.keys(none.downstream.arms).some((k) => k.endsWith("~nocb"))).toBe(false);
    const all = buildDownstream({ taskSet: ts, arms: new Map([["full_page", arm(FULL)], ["pruned_model", arm(MODEL)], ["closed_book", arm(ids.map(() => 1))]]), retention: new Map(), respondent: { model: "r", prompt_sha256: HASH("d") }, judge: { kind: "exact" }, bootstrap: { resamples: 200, seed: 1 } });
    expect(Object.keys(all.downstream.arms).some((k) => k.endsWith("~nocb"))).toBe(false);
    expect(all.closedBook!.flagged).toHaveLength(6);
    expect(closedBookAnalysis(ts, undefined, 0.3)).toBeNull();
  });

  it("an arm that answered only some questions is compared on the questions both answered", () => {
    const part: ArmScores = { correct: new Map(ids.slice(0, 6).map((id) => [id, 1 as const])), rows: ids.slice(0, 6).map((id) => row(id, "x", "")), judgeCost: new Map() };
    const { downstream: d } = build({ pruned_router: part });
    expect(d.arms["pruned_router"]!.n).toBe(6);
    expect(d.paired_deltas.find((p) => p.a === "pruned_router" && p.b === "full_page")!.mean_delta).toBe(0);
    expect(d.arms["pruned_router@product"]!.n).toBe(2);
  });

  it("the judge's cost is part of the arm's cost", () => {
    const withJudge: ArmScores = { ...arm(MODEL), judgeCost: new Map(ids.map((id) => [id, 0.01])) };
    const { downstream: d } = build({ pruned_model: withJudge });
    expect(d.arms["pruned_model"]!.cost_usd).toBeCloseTo(12 * 0.011, 12);
  });
});
