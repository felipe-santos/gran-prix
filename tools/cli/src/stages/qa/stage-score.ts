import { join } from "node:path";
import { assertValid, canonicalJson, contractId, type EvalReport, type Sha256 } from "@gran-prix/contracts";
import { defineStage, type StageOutputs, type StagePlugin } from "../../stage.js";
import type { ArtifactHandle } from "../../store.js";
import { CLOSED_BOOK, MarkdownBundle, RetentionIndex, armText, type Retention } from "./arms.js";
import { FsQaCache } from "./call.js";
import { CUT_TRIGGER } from "./cuts.js";
import type { ModelCaps } from "./model-params.js";
import { JUDGE_PROMPT_SHA256, RESPONDENT_PROMPT_SHA256 } from "./prompts.js";
import { buildDownstream, type ArmScores } from "./report.js";
import { judgeReviewHtml } from "./review-html.js";
import { scoreAnswers, keyOf, type HumanVerdicts, type ScoreResult } from "./score.js";
import { CAPABILITIES_SCHEMA, QA_CACHE_DIR, QaBudgetStopError, REAL_DEPS, ZERO_SHA, callModel, lazyTransport, modelBlock, num, optionalSingle, provenance, single, type ModelBlock, type QaStageDeps } from "./stage-common.js";
import { DEFAULT_RESAMPLES, DEFAULT_SEED } from "./stats.js";
import { ANSWERS_FORMAT, JUDGE_REVIEW_FORMAT, type AnswersDoc } from "./types.js";

/**
 * `ts:qa.score@1.0.0` (E3.4, protocol 9, steps 5 to 8): scores the answers of ONE respondent and writes the downstream
 * EvalReport in the conventions `scripts/decide-dom-v0.mjs` reads.
 *
 *  - facts by normalized exact / containment match, the rest by an LLM judge (the intermediate tier, never the
 *    respondent's own model) with the answer key; a stratified sample of at least 20% of what the judge graded goes to
 *    a person through `judge-review.html`, whose export comes back as the optional `human` input (the judge's
 *    verdict is hidden from the page; the agreement is reported, target 0.90);
 *  - evidence retention (M6) per arm and category; paired delta per question with the domain bootstrap
 *    (`@gran-prix/stats`, B = 10000, seed 20261125) and McNemar's exact p-value; closed-book pages above 30% flagged
 *    and the analysis repeated without them.
 *
 * When some answers could not be graded (the cut order sent them to the human queue and the human file does not cover
 * them yet) the stage writes the page and the details and NO report: grade the page, feed the export back, re-run.
 * `determinism: "cached-external"` (the judge), reserved from `ctx.ledger` first, cached by content hash.
 */

export const SCORE_IMPL = "ts:qa.score@1.0.0";
const dec = new TextDecoder();

const PARAMS_SCHEMA = {
  type: "object",
  required: ["judge", "model_id", "threshold"],
  additionalProperties: false,
  properties: {
    judge: modelBlock("The judge model (the intermediate tier). It must differ from the respondent's model; the stage refuses otherwise."),
    capabilities: CAPABILITIES_SCHEMA,
    arm_systems: { type: "object", additionalProperties: { type: "string", minLength: 1 }, description: "Arm -> system id in the markdown bundle (same as ts:qa.answer); retention is measured on those texts." },
    model_id: { type: "string", pattern: "^sha256:[0-9a-f]{64}$", description: "model_id of the frozen model the pruned_model arm uses (EvalReport.model_id)." },
    threshold: { type: "number", minimum: 0, maximum: 1, description: "tau*: the operating threshold of the pruned_model arm (EvalReport.threshold)." },
    dataset_id: { type: "string", pattern: "^sha256:[0-9a-f]{64}$", description: "Overrides the dataset id of the task set." },
    resamples: { type: "integer", minimum: 100, description: `Bootstrap resamples (default ${DEFAULT_RESAMPLES}, protocol 6.5).` },
    bootstrap_seed: { type: "integer", minimum: 0, description: `Bootstrap seed (default ${DEFAULT_SEED}, protocol 13).` },
    fact_max_words: { type: "integer", minimum: 1, description: "An answer of at most this many normalized words is a fact, decided by string matching alone (default 5)." },
    human_fraction: { type: "number", exclusiveMinimum: 0, maximum: 1, description: "Fraction of the judge-graded answers sent to a person, stratified by arm and verdict (default 0.2, the protocol's floor)." },
    sample_seed: { type: "string", minLength: 1, description: "Seed of the human sample (default 20261125)." },
    agreement_target: { type: "number", minimum: 0, maximum: 1, description: "Target agreement judge-human (default 0.9)." },
    closed_book_flag_above: { type: "number", minimum: 0, maximum: 1, description: "Pages whose closed-book accuracy is above this are flagged (default 0.3)." },
    concurrency: { type: "integer", minimum: 1 },
    dry_run: { type: "boolean", description: "Plan the judging (calls, cost, cache hits); call nothing, write no report." },
    retry_failed: { type: "boolean" },
    cut_trigger: { type: "number", exclusiveMinimum: 0, maximum: 1, description: `Fraction of the ledger cap at which step 2 of the cut order (judge to human) may apply (protocol 5.6: ${CUT_TRIGGER}).` },
    on_budget: { enum: ["fail", "partial"], description: "When the ledger stops the judge: fail (default; finished work stays cached) or continue with the answers the human queue will hold." },
  },
} as const;

interface Params {
  judge: ModelBlock;
  capabilities?: Record<string, ModelCaps>;
  arm_systems?: Record<string, string>;
  model_id: Sha256;
  threshold: number;
  dataset_id?: Sha256;
  resamples?: number;
  bootstrap_seed?: number;
  fact_max_words?: number;
  human_fraction?: number;
  sample_seed?: string;
  agreement_target?: number;
  closed_book_flag_above?: number;
  concurrency?: number;
  dry_run?: boolean;
  retry_failed?: boolean;
  cut_trigger?: number;
  on_budget?: "fail" | "partial";
}

function jsonDoc(h: ArtifactHandle, format: string): unknown {
  if (h.files().length === 0) return h.json();
  for (const f of [...h.files()].sort()) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(dec.decode(h.file(f))) as { format?: unknown };
      if (d.format === format) return d;
    } catch {
      // not a document
    }
  }
  throw new Error(`artifact ${h.id} holds no ${format} document`);
}

function readHuman(h: ArtifactHandle): HumanVerdicts {
  const d = jsonDoc(h, JUDGE_REVIEW_FORMAT) as { sample_id?: unknown; verdicts?: unknown };
  if (typeof d.sample_id !== "string" || !Array.isArray(d.verdicts)) throw new Error(`the human file is not a ${JUDGE_REVIEW_FORMAT} export`);
  const verdicts = new Map<string, "correct" | "incorrect">();
  for (const v of d.verdicts as Array<{ task_id?: unknown; arm?: unknown; verdict?: unknown }>) {
    if (typeof v.task_id !== "string" || typeof v.arm !== "string" || (v.verdict !== "correct" && v.verdict !== "incorrect")) throw new Error("a human verdict needs task_id, arm and verdict correct|incorrect");
    verdicts.set(keyOf(v.task_id, v.arm), v.verdict);
  }
  return { sample_id: d.sample_id, verdicts };
}

export function createScoreStage(deps: QaStageDeps = REAL_DEPS): StagePlugin {
  return defineStage(
    {
      kind: "evaluate",
      impl: SCORE_IMPL,
      inputs: [
        { name: "taskset", type: "QaTaskSet" },
        { name: "answers", type: "Bundle" },
        { name: "markdown", type: "Bundle" },
        { name: "human", type: "Bundle", optional: true },
      ],
      outputs: [
        { name: "report", type: "EvalReport", optional: true },
        { name: "details", type: "Bundle" },
        { name: "judge_review", type: "Bundle" },
      ],
      params_schema: PARAMS_SCHEMA,
      runtime: "node",
      determinism: "cached-external",
    },
    async (ctx): Promise<StageOutputs> => {
      const p = ctx.params as unknown as Params;
      const judgeModel = callModel(deps.provider, p.judge, p.capabilities);
      const taskSet = assertValid("qa-task-set", single(ctx, "taskset").json());
      const answers = jsonDoc(single(ctx, "answers"), ANSWERS_FORMAT) as AnswersDoc;
      if (answers.task_set_id !== taskSet.task_set_id) throw new Error(`the answers were made on task set ${answers.task_set_id}, not ${taskSet.task_set_id}`);
      if (answers.model === judgeModel.model) throw new Error(`the judge must differ from the respondent (protocol 9): both are "${answers.model}"`);
      const bundle = new MarkdownBundle(single(ctx, "markdown"));
      const humanHandle = optionalSingle(ctx, "human");
      const human = humanHandle === undefined ? undefined : readHuman(humanHandle);
      const dryRun = p.dry_run === true;
      const boot = { resamples: p.resamples ?? DEFAULT_RESAMPLES, seed: p.bootstrap_seed ?? DEFAULT_SEED };

      if (answers.status === "dropped") {
        ctx.log(`${answers.respondent} was dropped by the cut order (step 4): there is nothing to score; G3 rests on the other respondent, with a warning`);
        return { details: { files: { "details.json": `${canonicalJson({ format: "gran-prix.qa-score-details", format_version: "1.0.0", respondent: answers.respondent, status: "dropped", cut: answers.cut })}\n` } }, judge_review: { files: { "judge-review.html": judgeReviewHtml({ sample_id: ZERO_SHA, items: [] }) } } };
      }

      const result: ScoreResult = await scoreAnswers(
        taskSet,
        answers.rows,
        human,
        {
          fact_max_words: p.fact_max_words ?? 5,
          judge: judgeModel,
          concurrency: p.concurrency ?? 1,
          dry_run: dryRun,
          retry_failed: p.retry_failed === true,
          cut_trigger: num(ctx.params, "cut_trigger", CUT_TRIGGER),
          human_fraction: p.human_fraction ?? 0.2,
          sample_seed: p.sample_seed ?? "20261125",
        },
        { transport: lazyTransport(deps), ledger: ctx.ledger, cache: new FsQaCache(join(ctx.dataDir, QA_CACHE_DIR)) },
      );
      const page = { files: { "judge-review.html": judgeReviewHtml({ sample_id: result.sample.sample_id, items: result.sample.items.map((i) => ({ task_id: i.task_id, arm: i.arm, question: i.question, answer: i.answer, answer_variants: i.answer_variants, response: i.response })) }), "sample.json": `${canonicalJson({ format: "gran-prix.qa-judge-sample", ...result.sample })}\n` } };
      const j = result.judge;
      ctx.log(
        `${dryRun ? "DRY RUN (nothing spent): " : ""}${answers.respondent}: ${result.scored.length} answer(s), ${j.to_judge} to the judge (${j.cache_hits} cached, ${j.calls} call(s), ${dryRun ? `~$${j.est_expected_usd.toFixed(4)} estimated` : `spent $${j.spent_usd.toFixed(4)}`}); human page: ${result.sample.items.length} item(s) (${result.sample.items.filter((i) => i.role === "queue").length} queue)` +
          (result.cut ? `; CUT ORDER: ${result.cut.step}` : "") +
          (result.agreement ? `; judge-human agreement ${result.agreement.agreement.toFixed(3)} on ${result.agreement.n}/${result.agreement.of}` : ""),
      );
      if (result.budgetStop !== null && (p.on_budget ?? "fail") === "fail") {
        throw new QaBudgetStopError(`stopped at ${result.budgetStop}. Every paid response is cached under ${join(ctx.dataDir, QA_CACHE_DIR)}: re-run with a larger --budget-usd, or set on_budget "partial" to send the rest to the human queue`);
      }

      const detailsBase = {
        format: "gran-prix.qa-score-details",
        format_version: "1.0.0",
        respondent: answers.respondent,
        task_set_id: taskSet.task_set_id,
        answers_status: answers.status,
        answer_cuts: answers.cut,
        score_cut: result.cut,
        judge: { model: judgeModel.model, prompt_sha256: JUDGE_PROMPT_SHA256, ...j },
        agreement: result.agreement,
        unresolved: result.unresolved,
        by_method: countBy(result.scored, (s) => `${s.arm}|${s.method}`),
      };
      if (dryRun || result.unresolved > 0) {
        if (!dryRun) ctx.log(`${result.unresolved} answer(s) are not graded yet: grade judge-review.html (the queue items), feed its export back as the "human" input and re-run; no report was written`);
        return { details: { files: { "details.json": `${canonicalJson({ ...detailsBase, status: dryRun ? "dry_run" : "awaiting_human" })}\n` } }, judge_review: page };
      }

      // retention (M6) on the text each page-showing arm showed
      const idx = new RetentionIndex();
      const snapshotOf = new Map(taskSet.pages.map((pg) => [pg.group_id, pg.snapshot_id]));
      const scoredBy = new Map(result.scored.map((x) => [keyOf(x.task_id, x.arm), x]));
      const armScores = new Map<string, ArmScores>();
      const retention = new Map<string, Map<string, Retention>>();
      const uncovered: Record<string, number> = {};
      for (const arm of answers.arms) {
        const rows = answers.rows.filter((r) => r.arm === arm);
        if (rows.length === 0) continue;
        const s: ArmScores = { correct: new Map(), rows, judgeCost: new Map() };
        for (const r of rows) {
          const sc = scoredBy.get(keyOf(r.task_id, arm));
          if (sc === undefined || sc.correct === null) continue;
          s.correct.set(r.task_id, sc.correct ? 1 : 0);
          if (sc.judge_cost_usd > 0) s.judgeCost.set(r.task_id, sc.judge_cost_usd);
        }
        armScores.set(arm, s);
        if (arm === CLOSED_BOOK) continue;
        const rets = new Map<string, Retention>();
        const seenUncovered = new Set<string>();
        for (const t of taskSet.tasks) {
          if (!s.correct.has(t.id)) continue;
          const text = armText(bundle, arm, snapshotOf.get(t.group_id) as string, p.arm_systems ?? {});
          if (!text.covered) seenUncovered.add(t.group_id);
          rets.set(t.id, idx.retention(text.text ?? "", t.evidence.quote));
        }
        if (seenUncovered.size > 0) uncovered[arm] = seenUncovered.size;
        retention.set(arm, rets);
      }

      const llmJudged = result.scored.some((s) => s.method === "judge");
      const { downstream, closedBook } = buildDownstream({
        taskSet,
        arms: armScores,
        retention,
        respondent: { model: answers.model, prompt_sha256: RESPONDENT_PROMPT_SHA256 },
        judge: llmJudged ? { kind: "llm", model: judgeModel.model, rubric_sha256: JUDGE_PROMPT_SHA256, ...(result.agreement ? { human_agreement: result.agreement.agreement } : {}) } : { kind: "exact" },
        bootstrap: boot,
        ...(p.closed_book_flag_above !== undefined ? { closedBookFlagAbove: p.closed_book_flag_above } : {}),
      });

      const target = p.agreement_target ?? 0.9;
      const datasetId = p.dataset_id ?? taskSet.dataset_id;
      const notes: NonNullable<EvalReport["notes"]> = [
        ...(datasetId === undefined ? [{ kind: "note" as const, text: "dataset_id is a PLACEHOLDER (zeros): neither params.dataset_id nor a dataset for qa.generate was given, so the task set carries none." }] : []),
        { kind: "note", text: `Respondent ${answers.respondent} (${answers.model}); prompt ${answers.prompt_id}, max_tokens ${answers.max_tokens}, no tools; request params ${JSON.stringify(answers.request)}. Judge ${judgeModel.model}, request params ${JSON.stringify({ send_temperature: judgeModel.params.send_temperature, thinking: judgeModel.params.thinking, effort: judgeModel.params.effort })}.` },
        { kind: "note", text: `Scoring: answers of at most ${p.fact_max_words ?? 5} normalized words are facts, decided by normalized exact/containment match; the rest by the LLM judge with the answer key (${result.scored.filter((s) => s.method === "judge").length} judged). Delta = mean over questions of (correct_a - correct_b), a FRACTION; CI = percentile of ${boot.resamples} domain-cluster bootstrap replicates (seed ${boot.seed}); p = McNemar exact, two-sided, informative.` },
        ...(answers.cut.length > 0 || result.cut ? [{ kind: "threat" as const, text: `The cut order of protocol 5.6 was applied: ${[...answers.cut.map((c) => `${c.step} (${c.arms.join(", ")})`), ...(result.cut ? [result.cut.step] : [])].join("; ")}. Arms that were cut are absent from this report; a decision that needs them will refuse to run.` }] : []),
        ...(answers.status === "partial" ? [{ kind: "threat" as const, text: "The answers are PARTIAL (the budget stopped the run): arms may cover fewer questions than the task set; read each arm's n." }] : []),
        ...(Object.keys(uncovered).length > 0 ? [{ kind: "note" as const, text: `Pages with no output of the arm's system (empty page text, no credit): ${Object.entries(uncovered).map(([a, n]) => `${a} ${n}`).join(", ")}.` }] : []),
        ...(closedBook === null ? [] : [{ kind: closedBook.flagged.length > 0 ? ("threat" as const) : ("note" as const), text: closedBook.flagged.length > 0 ? `Closed-book accuracy above ${closedBook.flag_above} on ${closedBook.flagged.length} of ${closedBook.per_page.length} pages (memorization): ${closedBook.flagged.join(", ")}. The arms with suffix "~nocb" repeat full_page, pruned_model, pruned_router and oracle without them.` : `No page has closed-book accuracy above ${closedBook.flag_above}.` }]),
        ...(result.agreement === null ? [{ kind: "note" as const, text: `Human agreement with the judge: not measured yet (${result.sample.items.filter((i) => i.role === "sample").length} answer(s) await grading in judge-review.html; target ${target}).` }] : [{ kind: result.agreement.agreement >= target ? ("note" as const) : ("threat" as const), text: `Judge-human agreement ${result.agreement.agreement.toFixed(3)} on ${result.agreement.n} of ${result.agreement.of} sampled answers (kappa ${result.agreement.kappa === null ? "n/a" : result.agreement.kappa.toFixed(3)}); target ${target}. The judge's verdict is the score; ${result.agreement.disagreements.length} disagreement(s) are in the details.` }]),
      ];
      const gates: NonNullable<EvalReport["gates"]> =
        result.agreement === null
          ? []
          : [{ id: "QA_judge_agreement", rule: `agreement between the LLM judge and a human on a stratified sample of the judged answers >= ${target}`, value: result.agreement.agreement, passed: result.agreement.agreement >= target, comparator: ">=", threshold: target, unit: "agreement", metric: "judge_agreement", observed: result.agreement.agreement }];

      const allTest = taskSet.pages.every((pg) => pg.split === "test");
      const body = {
        format: "gran-prix.eval-report" as const,
        format_version: "1.1.0" as const,
        mode: "downstream" as const,
        model_id: p.model_id,
        dataset_id: datasetId ?? ZERO_SHA,
        split: allTest ? ("test" as const) : ("all" as const),
        threshold: p.threshold,
        downstream,
        ...(gates.length > 0 ? { gates } : {}),
        names: { model: `qa-${answers.respondent}` },
        notes,
        provenance: provenance(ctx),
      };
      const report = assertValid("eval-report", { ...body, report_id: contractId("eval-report", body as unknown as Record<string, unknown>) });
      const details = {
        ...detailsBase,
        status: "scored",
        closed_book: closedBook,
        uncovered_pages: uncovered,
        scored: result.scored.map((s) => ({ task_id: s.task_id, arm: s.arm, correct: s.correct, method: s.method, ...(s.judge_verdict ? { judge: s.judge_verdict } : {}), ...(s.human_verdict ? { human: s.human_verdict } : {}) })),
        retention: Object.fromEntries([...retention].map(([arm, m]) => [arm, Object.fromEntries([...m].map(([id, r]) => [id, r]))])),
      };
      return { report: { json: report }, details: { files: { "details.json": `${canonicalJson(details)}\n` } }, judge_review: page };
    },
  );
}

function countBy<T>(list: readonly T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of list) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort());
}

export const scoreStage: StagePlugin = createScoreStage();
