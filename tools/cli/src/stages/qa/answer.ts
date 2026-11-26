import type { QaTaskSet, Sha256 } from "@gran-prix/contracts";
import { isBudgetError, type LlmLedgerPort } from "@gran-prix/labels";
import { MarkdownBundle, armText, BASELINE_ARMS, PRUNED_ROUTER, type ArmText } from "./arms.js";
import { estimateOf, inputTokens, mapPool, runCall, type CallModel, type CallPlan, type QaCache } from "./call.js";
import { planCuts, CUT_TEXT, type CutStep } from "./cuts.js";
import { recordedParams } from "./model-params.js";
import { RESPONDENT_MAX_TOKENS, RESPONDENT_PROMPT_ID, RESPONDENT_PROMPT_SHA256, RESPONDENT_SYSTEM, respondentUser } from "./prompts.js";
import type { QaTransport } from "./transport.js";
import { ANSWERS_FORMAT, type AnswerRow, type AnswersDoc } from "./types.js";

/**
 * The respondent run (protocol 9: R1 and R2): every (task, arm) is answered by the model with the FIXED prompt,
 * `max_tokens` 200 and no tools, one call each, through the ledger and the content-hash cache. Arms are run one after
 * the other in priority order (`arms`), the page-major inside an arm, so the questions that share a page are adjacent
 * (the page is the cacheable prefix) and an arm is either complete or absent, never half-asked by a cut.
 *
 * Before each arm the cut order of 5.6 is consulted (`planCuts`): at 90% of the ledger's cap, and only while the work
 * still owed would not fit in what is left, R1 stops asking the baseline arms; R2 loses the router arm, then R2 stops.
 * Cuts are recorded in the output. A budget stop (the ledger refuses a reservation) ends the run with what is
 * done and cached: `on_budget: "partial"` returns it, `"fail"` throws.
 */

export interface AnswerConfig {
  respondent: "r1" | "r2";
  model: CallModel;
  arms: readonly string[];
  arm_systems: Readonly<Record<string, string>>;
  concurrency: number;
  on_budget: "fail" | "partial";
  retry_failed: boolean;
  dry_run: boolean;
  /** Fraction of the cap at which the cut order starts (protocol: 0.9). */
  cut_trigger: number;
}

export interface AnswerRuntime {
  transport?: QaTransport | undefined;
  ledger?: LlmLedgerPort | undefined;
  cache: QaCache;
  log?: ((m: string) => void) | undefined;
}

export interface ArmReport {
  arm: string;
  status: "done" | "cut" | "budget_stopped" | "not_started" | "dry_run";
  items: number;
  cache_hits: number;
  calls: number;
  est_expected_usd: number;
  est_worst_usd: number;
  cost_usd: number;
  spent_usd: number;
  /** Pages for which the arm's system had no output (empty page text). */
  uncovered_pages: number;
}

export interface AnswerResult {
  doc: AnswersDoc;
  report: { respondent: string; model: string; dry_run: boolean; arms: ArmReport[]; cuts: AnswersDoc["cut"]; budget_stop: string | null; totals: { items: number; cache_hits: number; calls: number; est_expected_usd: number; cost_usd: number; spent_usd: number } };
  budgetStop: string | null;
}

interface Item {
  task: QaTaskSet["tasks"][number];
  arm: string;
  text: ArmText;
}

function planOf(model: CallModel, system: string, promptSha256: Sha256, item: Item): CallPlan<string> {
  return {
    model,
    system,
    promptSha256,
    messages: [{ role: "user", content: respondentUser(item.text.text, item.task.question) }],
    maxTokens: RESPONDENT_MAX_TOKENS,
    contract: "qa.answer@1",
    parse: (t) => ({ ok: true, value: t }),
  };
}

const spentOf = (l: LlmLedgerPort): number => l.capUSD - l.remainingUSD();

export async function runAnswers(taskSet: QaTaskSet, bundle: MarkdownBundle, cfg: AnswerConfig, rt: AnswerRuntime): Promise<AnswerResult> {
  const snapshotOf = new Map(taskSet.pages.map((p) => [p.group_id, p.snapshot_id]));
  // page-major inside an arm: tasks are already grouped by page in the task set
  const itemsOf = (arm: string): Item[] =>
    taskSet.tasks.map((task) => ({ task, arm, text: armText(bundle, arm, snapshotOf.get(task.group_id) as string, cfg.arm_systems) }));
  const armItems = new Map(cfg.arms.map((a) => [a, itemsOf(a)]));

  // estimates per arm (what is NOT already cached)
  const est = new Map<string, { expected: number; worst: number; hits: number }>();
  for (const [arm, items] of armItems) {
    let expected = 0;
    let worst = 0;
    let hits = 0;
    for (const it of items) {
      const e = estimateOf(planOf(cfg.model, RESPONDENT_SYSTEM, RESPONDENT_PROMPT_SHA256, it), rt.cache, cfg.retry_failed, 12);
      if (e.hit) hits++;
      else {
        expected += e.expected_usd;
        worst += e.worst_usd;
      }
    }
    est.set(arm, { expected, worst, hits });
  }

  const rows: AnswerRow[] = [];
  const reports: ArmReport[] = [];
  const cuts: AnswersDoc["cut"] = [];
  let budgetStop: string | null = null;
  let dropped = false;
  const skipped = new Set<string>();

  for (let a = 0; a < cfg.arms.length; a++) {
    const arm = cfg.arms[a] as string;
    const items = armItems.get(arm) as Item[];
    const e = est.get(arm) as { expected: number; worst: number; hits: number };
    const rep: ArmReport = { arm, status: "not_started", items: items.length, cache_hits: e.hits, calls: 0, est_expected_usd: e.expected, est_worst_usd: e.worst, cost_usd: 0, spent_usd: 0, uncovered_pages: new Set(items.filter((i) => !i.text.covered).map((i) => i.task.group_id)).size };
    reports.push(rep);
    if (dropped) {
      rep.status = "cut";
      continue;
    }
    if (budgetStop !== null) continue;

    // The cut order (5.6), consulted before each arm with the work still owed (this arm included).
    if (!cfg.dry_run && rt.ledger !== undefined) {
      const owed = cfg.arms.slice(a).filter((x) => !skipped.has(x)).reduce((n, x) => n + (est.get(x)?.expected ?? 0), 0);
      const frees: Partial<Record<CutStep, number>> =
        cfg.respondent === "r1"
          ? { r1_baseline_arms: cfg.arms.slice(a).filter((x) => BASELINE_ARMS.includes(x)).reduce((n, x) => n + (est.get(x)?.expected ?? 0), 0) }
          : { r2_router_arm: cfg.arms.slice(a).includes(PRUNED_ROUTER) ? (est.get(PRUNED_ROUTER)?.expected ?? 0) : 0, r2_all: owed };
      const plan = planCuts({ capUSD: rt.ledger.capUSD, spentUSD: spentOf(rt.ledger), pendingUSD: owed, frees, trigger: cfg.cut_trigger });
      const reason = `ledger at ${(plan.spent_fraction * 100).toFixed(1)}% of the cap, $${owed.toFixed(4)} still owed, $${rt.ledger.remainingUSD().toFixed(4)} left`;
      if (plan.applied.includes("r2_all")) {
        cuts.push({ step: "r2_all", arms: cfg.arms.slice(a).filter((x) => !skipped.has(x)), reason: `${CUT_TEXT.r2_all}; ${reason}` });
        dropped = true;
        rep.status = "cut";
        continue;
      }
      const cutHere = (plan.applied.includes("r1_baseline_arms") && BASELINE_ARMS.includes(arm)) || (plan.applied.includes("r2_router_arm") && arm === PRUNED_ROUTER);
      if (cutHere) {
        const step = plan.applied.includes("r1_baseline_arms") ? "r1_baseline_arms" : "r2_router_arm";
        const present = cuts.find((c) => c.step === step);
        if (present) present.arms.push(arm);
        else cuts.push({ step, arms: [arm], reason: `${CUT_TEXT[step]}; ${reason}` });
        skipped.add(arm);
        rep.status = "cut";
        continue;
      }
    }

    if (cfg.dry_run) {
      rep.status = "dry_run";
      continue;
    }
    const pool = await mapPool(items, cfg.concurrency, async (it) => {
      const o = await runCall(planOf(cfg.model, RESPONDENT_SYSTEM, RESPONDENT_PROMPT_SHA256, it), { transport: rt.transport, ledger: rt.ledger, cache: rt.cache, retryFailed: cfg.retry_failed });
      return { it, o };
    });
    for (const r of pool.results) {
      if (r === undefined) continue;
      rep.calls += r.o.calls;
      rep.spent_usd += r.o.spent_usd;
      rep.cost_usd += r.o.cost_usd;
      rows.push({
        task_id: r.it.task.id,
        arm,
        text: r.o.value ?? "",
        input_tokens: inputTokens(r.o.usage),
        output_tokens: r.o.usage.output_tokens,
        cost_usd: r.o.cost_usd,
        page_sha256: r.it.text.sha256,
        ...(r.o.error !== undefined ? { error: r.o.error } : {}),
      });
    }
    if (pool.error !== undefined) {
      if (!isBudgetError(pool.error)) throw pool.error; // a network or API error: what finished is cached, a re-run resumes
      rep.status = "budget_stopped";
      budgetStop = `${arm}: ${pool.error instanceof Error ? pool.error.message : String(pool.error)}`;
    } else rep.status = "done";
  }

  const complete = reports.every((r) => r.status === "done" || (r.status === "cut" && skipped.has(r.arm)));
  const status: AnswersDoc["status"] = cfg.dry_run ? "dry_run" : dropped && rows.length === 0 ? "dropped" : complete && budgetStop === null && !dropped ? "complete" : "partial";
  const doc: AnswersDoc = {
    format: ANSWERS_FORMAT,
    format_version: "1.0.0",
    respondent: cfg.respondent,
    task_set_id: taskSet.task_set_id,
    model: cfg.model.model,
    prompt_id: RESPONDENT_PROMPT_ID,
    prompt_sha256: RESPONDENT_PROMPT_SHA256,
    request: recordedParams(cfg.model.params),
    max_tokens: RESPONDENT_MAX_TOKENS,
    arms: cfg.arms.filter((x) => !skipped.has(x)),
    cut: cuts,
    status,
    rows,
  };
  const sum = (f: (r: ArmReport) => number): number => reports.reduce((n, r) => n + f(r), 0);
  return {
    doc,
    report: {
      respondent: cfg.respondent,
      model: cfg.model.model,
      dry_run: cfg.dry_run,
      arms: reports,
      cuts,
      budget_stop: budgetStop,
      totals: { items: sum((r) => r.items), cache_hits: sum((r) => r.cache_hits), calls: sum((r) => r.calls), est_expected_usd: sum((r) => r.est_expected_usd), cost_usd: sum((r) => r.cost_usd), spent_usd: sum((r) => r.spent_usd) },
    },
    budgetStop,
  };
}
