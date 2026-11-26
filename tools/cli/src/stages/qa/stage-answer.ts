import { join } from "node:path";
import { assertValid, canonicalJson } from "@gran-prix/contracts";
import { defineStage, type StagePlugin } from "../../stage.js";
import { MarkdownBundle, R1_ARMS, R2_ARMS, isKnownArm } from "./arms.js";
import { runAnswers } from "./answer.js";
import { FsQaCache } from "./call.js";
import { CUT_TRIGGER } from "./cuts.js";
import type { ModelCaps } from "./model-params.js";
import { CAPABILITIES_SCHEMA, QA_CACHE_DIR, QaBudgetStopError, REAL_DEPS, callModel, lazyTransport, modelBlock, num, single, type ModelBlock, type QaStageDeps } from "./stage-common.js";
import { ANSWERS_FORMAT } from "./types.js";

/**
 * `ts:qa.answer@1.0.0` (E3.4, protocol 9, step 4): the respondents R1 (smallest tier) and R2 (intermediate). Every
 * (question, arm) pair is answered with the FIXED prompt, max_tokens 200, no tools; the arms read the markdown of
 * `ts:measure.tokens` (`full_page` = D2, the pruned arms = its `out/<system>/` files, `oracle` = the gold run through
 * the same converter as a system, `closed_book` = no page). One stage instance per respondent.
 *
 * Money: `determinism: "cached-external"`; every call is reserved from `ctx.ledger` first (cap $0 by default) and
 * cached by content hash in `<data dir>/qa-cache/`; `dry_run` plans without calling. The cut order of protocol 5.6
 * (baselines of R1, then the judge, then the router arm of R2, then R2) is applied at 90% of the cap and recorded.
 */

export const ANSWER_IMPL = "ts:qa.answer@1.0.0";

const PARAMS_SCHEMA = {
  type: "object",
  required: ["respondent", "llm"],
  additionalProperties: false,
  properties: {
    respondent: { enum: ["r1", "r2"], description: "r1 = the smallest tier (also asks the baseline arms), r2 = the intermediate tier (no baselines). Decides which steps of the cut order this stage owns." },
    llm: modelBlock("The respondent model. Frozen before the first call; it must differ from the judge."),
    capabilities: CAPABILITIES_SCHEMA,
    arms: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, description: "Arms in priority order (default: R1 = full_page, pruned_model, oracle, closed_book, pruned_router, pruned_readability, pruned_trafilatura, pruned_defuddle; R2 = the first five). The cut order removes from the end." },
    arm_systems: { type: "object", additionalProperties: { type: "string", minLength: 1 }, description: 'Arm -> system id in the markdown bundle (default: pruned_model "model", pruned_router "router", oracle "oracle", pruned_readability "readability", pruned_trafilatura "trafilatura", pruned_defuddle "defuddle").' },
    concurrency: { type: "integer", minimum: 1, description: "Calls in flight (default 1)." },
    dry_run: { type: "boolean", description: "Plan and print (calls, cache hits, tokens, cost); call nothing, spend nothing." },
    retry_failed: { type: "boolean", description: "Pay again for calls whose cached outcome is a failure." },
    on_budget: { enum: ["fail", "partial"], description: "When the ledger stops the run: fail the stage (default; finished work stays in the cache) or return what is finished." },
    cut_trigger: { type: "number", exclusiveMinimum: 0, maximum: 1, description: `Fraction of the ledger cap at which the cut order starts (protocol 5.6: ${CUT_TRIGGER}).` },
  },
} as const;

interface Params {
  respondent: "r1" | "r2";
  llm: ModelBlock;
  capabilities?: Record<string, ModelCaps>;
  arms?: string[];
  arm_systems?: Record<string, string>;
  concurrency?: number;
  dry_run?: boolean;
  retry_failed?: boolean;
  on_budget?: "fail" | "partial";
  cut_trigger?: number;
}

export function createAnswerStage(deps: QaStageDeps = REAL_DEPS): StagePlugin {
  return defineStage(
    {
      kind: "evaluate",
      impl: ANSWER_IMPL,
      inputs: [
        { name: "taskset", type: "QaTaskSet" },
        { name: "markdown", type: "Bundle" },
      ],
      outputs: [
        { name: "answers", type: "Bundle" },
        { name: "report", type: "Bundle" },
      ],
      params_schema: PARAMS_SCHEMA,
      runtime: "node",
      determinism: "cached-external",
    },
    async (ctx) => {
      const p = ctx.params as unknown as Params;
      const model = callModel(deps.provider, p.llm, p.capabilities);
      const arms = p.arms ?? [...(p.respondent === "r1" ? R1_ARMS : R2_ARMS)];
      const bad = arms.find((a) => !isKnownArm(a));
      if (bad !== undefined) throw new Error(`unknown arm "${bad}"`);
      if (new Set(arms).size !== arms.length) throw new Error("params.arms repeats an arm");
      const taskSet = assertValid("qa-task-set", single(ctx, "taskset").json());
      const bundle = new MarkdownBundle(single(ctx, "markdown"));
      const dryRun = p.dry_run === true;
      const res = await runAnswers(
        taskSet,
        bundle,
        {
          respondent: p.respondent,
          model,
          arms,
          arm_systems: p.arm_systems ?? {},
          concurrency: p.concurrency ?? 1,
          on_budget: p.on_budget ?? "fail",
          retry_failed: p.retry_failed === true,
          dry_run: dryRun,
          cut_trigger: num(ctx.params, "cut_trigger", CUT_TRIGGER),
        },
        { transport: lazyTransport(deps), ledger: ctx.ledger, cache: new FsQaCache(join(ctx.dataDir, QA_CACHE_DIR)), log: ctx.log },
      );
      const t = res.report.totals;
      ctx.log(
        `${dryRun ? "DRY RUN (nothing spent): " : ""}${p.respondent}: ${t.items} answer(s) over ${arms.length} arm(s), ${t.cache_hits} cache hit(s), ${t.calls} call(s); ` +
          (dryRun ? `estimated $${t.est_expected_usd.toFixed(4)} for the calls still to pay` : `spent $${t.spent_usd.toFixed(4)}`) +
          (res.report.cuts.length > 0 ? `; CUT ORDER applied: ${res.report.cuts.map((c) => c.step).join(", ")}` : ""),
      );
      if (res.budgetStop !== null && (p.on_budget ?? "fail") === "fail") {
        throw new QaBudgetStopError(`stopped at ${res.budgetStop}. Every paid response is cached under ${join(ctx.dataDir, QA_CACHE_DIR)}: re-run with a larger --budget-usd to resume without paying twice`);
      }
      return {
        answers: { files: { "answers.json": `${canonicalJson(res.doc)}\n` } },
        report: { json: { format: "gran-prix.qa-answer-report", format_version: "1.0.0", answers_format: ANSWERS_FORMAT, ...res.report } },
      };
    },
  );
}

export const answerStage: StagePlugin = createAnswerStage();
