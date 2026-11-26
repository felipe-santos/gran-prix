// QA tool, the respondents (R1 and R2) and the cut order of protocol 5.6, with the fake transport: the fixed prompt, one call per
// (question, arm), the cache, the dry run, and what the ledger does to the arms at 90% of the cap.
import { afterAll, describe, expect, it } from "vitest";
import type { QaTaskSet } from "@gran-prix/contracts";
import { R1_ARMS, R2_ARMS } from "../src/stages/qa/arms.js";
import { runAnswers, type AnswerConfig } from "../src/stages/qa/answer.js";
import { MemoryQaCache } from "../src/stages/qa/call.js";
import { CUT_ORDER, CUT_TRIGGER, planCuts } from "../src/stages/qa/cuts.js";
import { RESPONDENT_MAX_TOKENS, RESPONDENT_PROMPT_SHA256, RESPONDENT_SYSTEM } from "../src/stages/qa/prompts.js";
import { QaFakeTransport, contentText, type QaRequest } from "../src/stages/qa/transport.js";
import { bundleOf, callModel, ledgerPort, taskSet } from "./qa-fixtures.js";
import { cleanupTmp } from "./helpers.js";

afterAll(cleanupTmp);

const TS = (): QaTaskSet =>
  taskSet([
    { page: "alpha", stratum: "docs", n: 2, question: "Alpha question?", answer: "alpha-answer" },
    { page: "beta", stratum: "product", n: 2, question: "Beta question?", answer: "beta-answer" },
  ]);

const SYSTEMS = { model: "model", router: "router", oracle: "oracle", readability: "readability", trafilatura: "trafilatura", defuddle: "defuddle" } as const;

/** Page text: full page says everything; every pruned arm says only `short`; `big` systems are long (their calls cost real money). */
function bundle(ts: QaTaskSet, big: readonly string[] = []): ReturnType<typeof bundleOf> {
  const d2 = (_s: string, stratum: string): string => `# ${stratum}\n\nThe answer to the Alpha question is alpha-answer. The answer to the Beta question is beta-answer. Padding.`;
  const sys = (name: string) => (_s: string, stratum: string): string => (big.includes(name) ? `# ${stratum}\n\n${name} ${"filler words ".repeat(5000)}` : `# ${stratum}\n\nShort text of ${name}.`);
  return bundleOf(ts, { d2, systems: Object.fromEntries(Object.values(SYSTEMS).map((n) => [n, sys(n)])) });
}

/** A respondent that answers from the page when the page contains `The answer to the X question is Y.` */
const respondent = (): QaFakeTransport =>
  new QaFakeTransport((req: QaRequest) => {
    const text = contentText(req.messages[0]!.content);
    const q = /Question: (\w+) question/.exec(text)?.[1] ?? "";
    const m = new RegExp(`The answer to the ${q} question is ([\\w-]+)\\.`).exec(text);
    return m ? (m[1] as string) : "NOT_FOUND";
  });

const cfg = (over: Partial<AnswerConfig> = {}): AnswerConfig => ({
  respondent: "r1",
  model: callModel("test-haiku-model"),
  arms: R1_ARMS,
  arm_systems: {},
  concurrency: 1,
  on_budget: "partial",
  retry_failed: false,
  dry_run: false,
  cut_trigger: CUT_TRIGGER,
  ...over,
});

describe("the respondent run", () => {
  it("one call per (question, arm) with the fixed prompt, max_tokens 200 and no tools, and the arms differ in what they show", async () => {
    const ts = TS();
    const t = respondent();
    const { port } = ledgerPort(100);
    const res = await runAnswers(ts, bundle(ts), cfg(), { transport: t, ledger: port, cache: new MemoryQaCache() });
    expect(t.calls).toHaveLength(4 * R1_ARMS.length);
    for (const c of t.calls) {
      expect(c.system).toBe(RESPONDENT_SYSTEM);
      expect(c.maxTokens).toBe(RESPONDENT_MAX_TOKENS);
      expect(c).not.toHaveProperty("temperature"); // the current models reject it
      expect(c).not.toHaveProperty("tools");
      expect(c).not.toHaveProperty("schema"); // free text
    }
    expect(res.doc).toMatchObject({ respondent: "r1", status: "complete", prompt_sha256: RESPONDENT_PROMPT_SHA256, max_tokens: 200, model: "test-haiku-model", request: { send_temperature: false, thinking: "off", effort: null } });
    expect(res.doc.arms).toEqual([...R1_ARMS]);
    const by = (arm: string): string[] => res.doc.rows.filter((r) => r.arm === arm).map((r) => r.text);
    expect(by("full_page")).toEqual(["alpha-answer", "alpha-answer", "beta-answer", "beta-answer"]);
    expect(by("pruned_model")).toEqual(["NOT_FOUND", "NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]); // the pruned page lost the evidence
    expect(by("closed_book")).toEqual(["NOT_FOUND", "NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]);
    // the page is the cacheable prefix; closed book has no page
    const full = t.calls.find((c) => typeof c.messages[0]!.content !== "string" && (c.messages[0]!.content as Array<{ cache?: boolean; text: string }>)[0]!.text.includes("# docs"))!;
    expect((full.messages[0]!.content as Array<{ cache?: boolean }>)[0]!.cache).toBe(true);
    const closed = t.calls.filter((c) => contentText(c.messages[0]!.content).startsWith("No page text is given"));
    expect(closed).toHaveLength(4);
    expect(res.doc.rows.every((r) => r.input_tokens > 0 && r.output_tokens > 0 && r.cost_usd > 0)).toBe(true);
    expect(res.doc.rows.find((r) => r.arm === "closed_book")!.page_sha256).toBeNull();
    expect(res.doc.rows.find((r) => r.arm === "full_page")!.page_sha256).toMatch(/^sha256:/);
  });

  it("a second run answers everything from the cache: no call, no spending, the same answers", async () => {
    const ts = TS();
    const cache = new MemoryQaCache();
    const first = await runAnswers(ts, bundle(ts), cfg(), { transport: respondent(), ledger: ledgerPort(100).port, cache });
    const t2 = respondent();
    const { port, ledger } = ledgerPort(100);
    const second = await runAnswers(ts, bundle(ts), cfg(), { transport: t2, ledger: port, cache });
    expect(t2.calls).toHaveLength(0);
    expect(ledger.spentUSD()).toBe(0);
    expect(second.doc.rows.map((r) => [r.task_id, r.arm, r.text])).toEqual(first.doc.rows.map((r) => [r.task_id, r.arm, r.text]));
    expect(second.report.totals.cache_hits).toBe(4 * R1_ARMS.length);
  });

  it("a dry run plans without calling or spending, and says what a real run would cost and what is cached", async () => {
    const ts = TS();
    const t = respondent();
    const { port, ledger } = ledgerPort(100);
    const res = await runAnswers(ts, bundle(ts), cfg({ dry_run: true }), { transport: t, ledger: port, cache: new MemoryQaCache() });
    expect(t.calls).toHaveLength(0);
    expect(ledger.spentUSD()).toBe(0);
    expect(res.doc.status).toBe("dry_run");
    expect(res.report.totals.est_expected_usd).toBeGreaterThan(0);
    expect(res.report.arms.every((a) => a.status === "dry_run")).toBe(true);
  });

  it("concurrency changes nothing about the answers or their order", async () => {
    const ts = TS();
    const a = await runAnswers(ts, bundle(ts), cfg(), { transport: respondent(), ledger: ledgerPort(100).port, cache: new MemoryQaCache() });
    const b = await runAnswers(ts, bundle(ts), cfg({ concurrency: 5 }), { transport: respondent(), ledger: ledgerPort(100).port, cache: new MemoryQaCache() });
    expect(b.doc.rows.map((r) => [r.task_id, r.arm, r.text])).toEqual(a.doc.rows.map((r) => [r.task_id, r.arm, r.text]));
  });

  it("a pruned arm whose system the bundle does not have is an error, not an empty arm; a page the system skips is an empty page, counted", async () => {
    const ts = TS();
    const noRouter = bundleOf(ts, { d2: () => "full", systems: { model: () => "m", oracle: () => "o" } });
    await expect(runAnswers(ts, noRouter, cfg({ arms: ["full_page", "pruned_router"] }), { transport: respondent(), ledger: ledgerPort(100).port, cache: new MemoryQaCache() })).rejects.toThrow(/system "router"/);
    const partial = bundleOf(ts, { d2: () => "full", systems: { model: (_s, stratum) => (stratum === "docs" ? "m" : null) } });
    const res = await runAnswers(ts, partial, cfg({ arms: ["full_page", "pruned_model"] }), { transport: respondent(), ledger: ledgerPort(100).port, cache: new MemoryQaCache() });
    expect(res.report.arms.find((a) => a.arm === "pruned_model")!.uncovered_pages).toBe(1);
  });
});

describe("planCuts: the pre-registered order", () => {
  const base = { capUSD: 10, pendingUSD: 5, trigger: 0.9 };

  it("nothing is cut under 90% of the cap, even when the work does not fit", () => {
    expect(planCuts({ ...base, spentUSD: 8.9, frees: { r1_baseline_arms: 3 } })).toMatchObject({ triggered: false, applied: [] });
  });

  it("at 90% nothing is cut while the remaining work fits in what is left", () => {
    expect(planCuts({ ...base, spentUSD: 9, pendingUSD: 0.9, frees: { r1_baseline_arms: 0.5 } })).toMatchObject({ triggered: true, applied: [], fits: true });
  });

  it("at 90% the steps are taken in order and only as far as needed", () => {
    const frees = { r1_baseline_arms: 3, judge_to_human: 1.5, r2_router_arm: 1, r2_all: 6 };
    expect(planCuts({ ...base, spentUSD: 9.2, pendingUSD: 3.5, frees }).applied).toEqual(["r1_baseline_arms"]); // 3.5 - 3 = 0.5 <= 0.8
    expect(planCuts({ ...base, spentUSD: 9.2, pendingUSD: 4.5, frees }).applied).toEqual(["r1_baseline_arms", "judge_to_human"]); // 4.5 - 3 - 1.5 = 0
    expect(planCuts({ ...base, spentUSD: 9.2, pendingUSD: 5.5, frees }).applied).toEqual(["r1_baseline_arms", "judge_to_human", "r2_router_arm"]);
    expect(planCuts({ ...base, spentUSD: 9.2, pendingUSD: 9, frees }).applied).toEqual([...CUT_ORDER]);
  });

  it("a step that frees nothing in the calling stage is skipped, but never reordered past a step that could still free money", () => {
    const p = planCuts({ ...base, spentUSD: 9.5, pendingUSD: 2, frees: { r2_router_arm: 1.6 } });
    expect(p.applied).toEqual(["r2_router_arm"]);
    expect(p.fits).toBe(true);
    const q = planCuts({ ...base, spentUSD: 9.5, pendingUSD: 2, frees: { r2_all: 2 } });
    expect(q.applied).toEqual(["r2_all"]);
  });

  it("with the cap at zero everything is over the trigger", () => {
    expect(planCuts({ capUSD: 0, spentUSD: 0, pendingUSD: 1, frees: { r1_baseline_arms: 1 } }).applied).toEqual(["r1_baseline_arms"]);
  });
});

describe("the cut order in the respondent runs", () => {
  /** Spends `fraction` of the cap before the stage starts (the ledger is cumulative across runs). */
  function spend(cap: number, fraction: number): ReturnType<typeof ledgerPort> {
    const l = ledgerPort(cap);
    l.ledger.reserve(cap * fraction).commit();
    return l;
  }

  it("R1: at 90% the baseline arms are not asked (and the arms before them are complete), recorded with the reason", async () => {
    const ts = TS();
    const t = respondent();
    const { port } = spend(1, 0.9);
    const res = await runAnswers(ts, bundle(ts, ["readability", "trafilatura", "defuddle"]), cfg(), { transport: t, ledger: port, cache: new MemoryQaCache() });
    expect(res.doc.arms).toEqual(["full_page", "pruned_model", "oracle", "closed_book", "pruned_router"]);
    expect(res.doc.cut).toHaveLength(1);
    expect(res.doc.cut[0]).toMatchObject({ step: "r1_baseline_arms", arms: ["pruned_readability", "pruned_trafilatura", "pruned_defuddle"] });
    expect(res.doc.cut[0]!.reason).toMatch(/9\d\.\d% of the cap/);
    expect(res.doc.status).toBe("complete"); // what was asked is complete; the cut arms are not in `arms`
    expect(res.doc.rows.filter((r) => r.arm === "pruned_readability")).toHaveLength(0);
    expect(res.doc.rows.filter((r) => r.arm === "pruned_router")).toHaveLength(4);
    expect(res.report.arms.filter((a) => a.status === "cut").map((a) => a.arm)).toEqual(["pruned_readability", "pruned_trafilatura", "pruned_defuddle"]);
    expect(res.budgetStop).toBeNull();
  });

  it("R1 under 90% with the same large baselines: nothing is cut, the ledger decides (a budget stop, not a silent cut)", async () => {
    const ts = TS();
    const { port } = spend(1, 0.7);
    const res = await runAnswers(ts, bundle(ts, ["readability", "trafilatura", "defuddle"]), cfg(), { transport: respondent(), ledger: port, cache: new MemoryQaCache() });
    expect(res.doc.cut).toEqual([]);
    expect(res.budgetStop).toMatch(/pruned_readability|pruned_trafilatura|pruned_defuddle/);
    expect(res.doc.status).toBe("partial");
  });

  it("R2: the router arm goes first (step 3); when that is not enough R2 stops entirely (step 4)", async () => {
    const ts = TS();
    const one = await runAnswers(ts, bundle(ts, ["router"]), cfg({ respondent: "r2", arms: R2_ARMS }), { transport: respondent(), ledger: spend(1, 0.9).port, cache: new MemoryQaCache() });
    expect(one.doc.cut.map((c) => c.step)).toEqual(["r2_router_arm"]);
    expect(one.doc.arms).toEqual(["full_page", "pruned_model", "oracle", "closed_book"]);
    expect(one.doc.rows.some((r) => r.arm === "pruned_router")).toBe(false);

    // nothing left at all: even the first arm does not fit -> the whole of R2 is dropped before any call
    const t = respondent();
    const all = await runAnswers(ts, bundle(ts, ["router", "model", "oracle"]), cfg({ respondent: "r2", arms: R2_ARMS }), { transport: t, ledger: spend(1, 0.999999).port, cache: new MemoryQaCache() });
    expect(all.doc.cut.map((c) => c.step)).toEqual(["r2_all"]);
    expect(all.doc.status).toBe("dropped");
    expect(all.doc.rows).toEqual([]);
    expect(t.calls).toHaveLength(0);
    expect(all.doc.cut[0]!.reason).toMatch(/G3 then rests on R1 alone/);
  });

  it("the cache makes cut decisions about what is still owed, not about what was already paid", async () => {
    const ts = TS();
    const cache = new MemoryQaCache();
    // pay everything with a rich ledger first
    await runAnswers(ts, bundle(ts, ["readability", "trafilatura", "defuddle"]), cfg(), { transport: respondent(), ledger: ledgerPort(100).port, cache });
    // now the ledger is "at 90%" but nothing is owed: no cut, all arms returned from the cache
    const t = respondent();
    const res = await runAnswers(ts, bundle(ts, ["readability", "trafilatura", "defuddle"]), cfg(), { transport: t, ledger: spend(1, 0.95).port, cache });
    expect(res.doc.cut).toEqual([]);
    expect(res.doc.arms).toEqual([...R1_ARMS]);
    expect(t.calls).toHaveLength(0);
  });
});
