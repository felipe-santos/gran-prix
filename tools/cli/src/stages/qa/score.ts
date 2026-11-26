import { canonicalJson, sha256Hex, sha256Of, type QaTaskSet, type Sha256 } from "@gran-prix/contracts";
import { isBudgetError, type LlmLedgerPort } from "@gran-prix/labels";
import { estimateOf, mapPool, runCall, type CallModel, type CallPlan, type QaCache } from "./call.js";
import { planCuts, CUT_TEXT, type CutStep } from "./cuts.js";
import { JUDGE_MAX_TOKENS, JUDGE_PROMPT_SHA256, JUDGE_SCHEMA, JUDGE_SYSTEM, NOT_FOUND, judgeUser, parseVerdict, verdictCorrection } from "./prompts.js";
import { cohenKappa } from "./stats.js";
import { isFact, matchAnswer, normalizeAnswer } from "./text.js";
import type { QaTransport } from "./transport.js";
import type { AnswerRow } from "./types.js";

/**
 * Scoring (protocol 9, "Pontuacao"):
 *  - FACTS (an answer of at most `fact_max_words` normalized words) are decided by string matching alone: the response
 *    equals the key or a variant, or contains one as whole words (`exact`, `contains`), else it is wrong;
 *  - the REST goes to the LLM judge (an intermediate model, never the respondent's own) with the answer key; a response
 *    that is empty, an error, or just `NOT_FOUND` is wrong without a call;
 *  - a stratified sample of at least `human_fraction` of what the judge graded goes to a person, who is shown the
 *    response and the key but NOT the judge's verdict; the agreement is reported (target 0.90). The judge's verdict stays
 *    the score; the human's only validates it, except for the answers the judge never saw (the cut order's step 2 sends
 *    them to the human queue), where the human's verdict IS the score.
 */

export type Method = "exact" | "contains" | "fact_no_match" | "not_found" | "no_response" | "judge" | "human";

export interface ScoredAnswer {
  task_id: string;
  arm: string;
  correct: boolean | null;
  method: Method | "unresolved";
  judge_verdict?: "correct" | "incorrect";
  human_verdict?: "correct" | "incorrect";
  judge_cost_usd: number;
}

export interface ScoreConfig {
  fact_max_words: number;
  judge: CallModel;
  concurrency: number;
  dry_run: boolean;
  retry_failed: boolean;
  cut_trigger: number;
  human_fraction: number;
  sample_seed: string;
}

export interface ScoreRuntime {
  transport?: QaTransport | undefined;
  ledger?: LlmLedgerPort | undefined;
  cache: QaCache;
}

export interface HumanVerdicts {
  sample_id: string;
  verdicts: ReadonlyMap<string, "correct" | "incorrect">;
}

export const keyOf = (taskId: string, arm: string): string => `${taskId}|${arm}`;

export function judgePlan(model: CallModel, task: QaTaskSet["tasks"][number], response: string): CallPlan<"correct" | "incorrect"> {
  return {
    model,
    system: JUDGE_SYSTEM,
    promptSha256: JUDGE_PROMPT_SHA256,
    messages: [{ role: "user", content: judgeUser(task.question, task.answer, task.answer_variants, response) }],
    maxTokens: JUDGE_MAX_TOKENS,
    contract: "qa.judge@1",
    schema: JUDGE_SCHEMA,
    parse: parseVerdict,
    correction: verdictCorrection,
  };
}

/** The decision that needs no model: a method and a verdict, or null when the judge (or a human) is needed. */
export function deterministic(row: AnswerRow, task: QaTaskSet["tasks"][number], factMaxWords: number): { correct: boolean; method: Method } | null {
  if (row.error !== undefined || row.text.trim() === "") return { correct: false, method: "no_response" };
  const m = matchAnswer(row.text, task.answer, task.answer_variants);
  if (m !== null) return { correct: true, method: m };
  if (normalizeAnswer(row.text) === normalizeAnswer(NOT_FOUND)) return { correct: false, method: "not_found" };
  if (isFact(task.answer, factMaxWords)) return { correct: false, method: "fact_no_match" };
  return null;
}

export interface JudgeSample {
  /** sha256 of the items (their keys and responses): a human file made on another sample is refused. */
  sample_id: Sha256;
  items: Array<{ task_id: string; arm: string; question: string; answer: string; answer_variants: string[]; response: string; role: "sample" | "queue" }>;
}

export interface ScoreResult {
  scored: ScoredAnswer[];
  cut: { step: CutStep; reason: string } | null;
  judge: { calls: number; cache_hits: number; est_expected_usd: number; spent_usd: number; cost_usd: number; to_judge: number };
  sample: JudgeSample;
  /** Agreement of the human sample with the judge (null until a human file covers it). */
  agreement: { n: number; of: number; agreement: number; kappa: number | null; disagreements: Array<{ task_id: string; arm: string; judge: string; human: string }> } | null;
  budgetStop: string | null;
  unresolved: number;
}

/** Stratified sample of the judged answers: strata = arm x verdict, `ceil(fraction x n)` of each, picked by hash order of the seed. */
export function stratifiedSample(judged: ReadonlyArray<{ task_id: string; arm: string; verdict: string }>, fraction: number, seed: string): Array<{ task_id: string; arm: string }> {
  const strata = new Map<string, Array<{ task_id: string; arm: string }>>();
  for (const j of judged) {
    const k = `${j.arm}|${j.verdict}`;
    const list = strata.get(k) ?? [];
    list.push({ task_id: j.task_id, arm: j.arm });
    strata.set(k, list);
  }
  const out: Array<{ task_id: string; arm: string }> = [];
  for (const k of [...strata.keys()].sort()) {
    const list = strata.get(k) as Array<{ task_id: string; arm: string }>;
    const ranked = [...list].sort((a, b) => {
      const ha = sha256Hex(`${seed}|${a.task_id}|${a.arm}`);
      const hb = sha256Hex(`${seed}|${b.task_id}|${b.arm}`);
      return ha < hb ? -1 : ha > hb ? 1 : 0;
    });
    out.push(...ranked.slice(0, Math.ceil(fraction * list.length)));
  }
  return out;
}

export async function scoreAnswers(taskSet: QaTaskSet, rows: readonly AnswerRow[], human: HumanVerdicts | undefined, cfg: ScoreConfig, rt: ScoreRuntime): Promise<ScoreResult> {
  const task = new Map(taskSet.tasks.map((t) => [t.id, t]));
  const scored = new Map<string, ScoredAnswer>();
  const toJudge: Array<{ row: AnswerRow; task: QaTaskSet["tasks"][number] }> = [];
  for (const row of rows) {
    const t = task.get(row.task_id);
    if (t === undefined) throw new Error(`answer for unknown task "${row.task_id}"`);
    const k = keyOf(row.task_id, row.arm);
    if (scored.has(k)) throw new Error(`two answers for ${k}`);
    const d = deterministic(row, t, cfg.fact_max_words);
    if (d !== null) scored.set(k, { task_id: row.task_id, arm: row.arm, correct: d.correct, method: d.method, judge_cost_usd: 0 });
    else {
      scored.set(k, { task_id: row.task_id, arm: row.arm, correct: null, method: "unresolved", judge_cost_usd: 0 });
      toJudge.push({ row, task: t });
    }
  }
  const plans = toJudge.map((x) => ({ ...x, plan: judgePlan(cfg.judge, x.task, x.row.text) }));
  const ests = plans.map((p) => estimateOf(p.plan, rt.cache, cfg.retry_failed, 8));
  const pending = ests.reduce((n, e) => n + (e.hit ? 0 : e.expected_usd), 0);
  const judgeStats: ScoreResult["judge"] = { calls: 0, cache_hits: ests.filter((e) => e.hit).length, est_expected_usd: pending, spent_usd: 0, cost_usd: 0, to_judge: plans.length };

  // Step 2 of the cut order: the judge stops, what it has not graded (and is not cached) goes to the human queue.
  let cut: ScoreResult["cut"] = null;
  let stopJudge = false;
  if (!cfg.dry_run && rt.ledger !== undefined && pending > 0) {
    const plan = planCuts({ capUSD: rt.ledger.capUSD, spentUSD: rt.ledger.capUSD - rt.ledger.remainingUSD(), pendingUSD: pending, frees: { judge_to_human: pending }, trigger: cfg.cut_trigger });
    if (plan.applied.includes("judge_to_human")) {
      stopJudge = true;
      cut = { step: "judge_to_human", reason: `${CUT_TEXT.judge_to_human}; ledger at ${(plan.spent_fraction * 100).toFixed(1)}% of the cap, $${pending.toFixed(4)} of judging still owed, $${rt.ledger.remainingUSD().toFixed(4)} left` };
    }
  }

  let budgetStop: string | null = null;
  const judged = new Map<string, "correct" | "incorrect">();
  if (!cfg.dry_run) {
    const todo = plans.filter((_, i) => !stopJudge || (ests[i] as { hit: boolean }).hit);
    const pool = await mapPool(todo, cfg.concurrency, async (p) => ({ p, o: await runCall(p.plan, { transport: rt.transport, ledger: rt.ledger, cache: rt.cache, retryFailed: cfg.retry_failed }) }));
    for (const r of pool.results) {
      if (r === undefined) continue;
      judgeStats.calls += r.o.calls;
      judgeStats.spent_usd += r.o.spent_usd;
      judgeStats.cost_usd += r.o.cost_usd;
      const s = scored.get(keyOf(r.p.row.task_id, r.p.row.arm)) as ScoredAnswer;
      s.judge_cost_usd = r.o.cost_usd;
      if (r.o.value !== undefined) {
        judged.set(keyOf(r.p.row.task_id, r.p.row.arm), r.o.value);
        s.correct = r.o.value === "correct";
        s.method = "judge";
        s.judge_verdict = r.o.value;
      }
      // a judge answer that stayed invalid after the retry is left unresolved: it goes to the human queue
    }
    if (pool.error !== undefined) {
      if (!isBudgetError(pool.error)) throw pool.error;
      budgetStop = `judge: ${pool.error instanceof Error ? pool.error.message : String(pool.error)}`;
    }
  }

  // The human page: the answers nobody graded (queue) and the stratified sample of the judged ones.
  const queue = [...scored.values()].filter((s) => s.method === "unresolved");
  const sampleKeys = stratifiedSample(
    [...scored.values()].filter((s) => s.method === "judge").map((s) => ({ task_id: s.task_id, arm: s.arm, verdict: s.judge_verdict as string })),
    cfg.human_fraction,
    cfg.sample_seed,
  );
  const rowOf = new Map(rows.map((r) => [keyOf(r.task_id, r.arm), r]));
  const sampleItems: JudgeSample["items"] = [
    ...queue.map((s) => ({ s, role: "queue" as const })),
    ...sampleKeys.map((k) => ({ s: scored.get(keyOf(k.task_id, k.arm)) as ScoredAnswer, role: "sample" as const })),
  ]
    .map(({ s, role }) => {
      const t = task.get(s.task_id) as QaTaskSet["tasks"][number];
      return { task_id: s.task_id, arm: s.arm, question: t.question, answer: t.answer, answer_variants: t.answer_variants, response: (rowOf.get(keyOf(s.task_id, s.arm)) as AnswerRow).text, role };
    })
    .sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : a.arm < b.arm ? -1 : a.arm > b.arm ? 1 : 0));
  const sample: JudgeSample = { sample_id: sha256Of(canonicalJson(sampleItems.map((i) => [i.task_id, i.arm, i.response]))), items: sampleItems };

  let agreement: ScoreResult["agreement"] = null;
  if (human !== undefined) {
    if (human.sample_id !== sample.sample_id) {
      throw new Error(`the human file was made on sample ${human.sample_id}, this run's sample is ${sample.sample_id}: the answers or the judge changed; grade the page of THIS run`);
    }
    const dis: NonNullable<ScoreResult["agreement"]>["disagreements"] = [];
    const h: boolean[] = [];
    const j: boolean[] = [];
    for (const it of sample.items) {
      const v = human.verdicts.get(keyOf(it.task_id, it.arm));
      const s = scored.get(keyOf(it.task_id, it.arm)) as ScoredAnswer;
      if (v === undefined) continue;
      s.human_verdict = v;
      if (it.role === "queue") {
        s.correct = v === "correct";
        s.method = "human";
      } else {
        h.push(v === "correct");
        j.push(s.judge_verdict === "correct");
        if ((v === "correct") !== (s.judge_verdict === "correct")) dis.push({ task_id: it.task_id, arm: it.arm, judge: s.judge_verdict as string, human: v });
      }
    }
    const nSample = sample.items.filter((i) => i.role === "sample").length;
    if (h.length > 0) agreement = { n: h.length, of: nSample, agreement: h.filter((x, i) => x === j[i]).length / h.length, kappa: cohenKappa(h, j), disagreements: dis };
  }
  const unresolved = [...scored.values()].filter((s) => s.method === "unresolved").length;
  return { scored: [...scored.values()], cut, judge: judgeStats, sample, agreement, budgetStop, unresolved };
}
