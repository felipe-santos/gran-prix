import type { EvalReport, QaTaskSet, Sha256 } from "@gran-prix/contracts";
import { CLOSED_BOOK, FULL_PAGE, ORACLE, PRUNED_MODEL, PRUNED_ROUTER, type Retention } from "./arms.js";
import { clusterMeanCi, groupKeyOf, pairedDelta, type BootstrapConfig } from "./stats.js";
import type { AnswerRow } from "./types.js";

/**
 * The downstream section of an EvalReport, in the conventions `scripts/decide-dom-v0.mjs` reads (and checked against
 * the contract by `assertValid`):
 *
 *  - `arms[arm]`: n, score_mean (accuracy), score_ci95 (cluster bootstrap by domain), tokens_in_mean (every input token
 *    of the arm's calls), cost_usd (respondent + judge), `evidence_retention` for the arms that show a page;
 *  - `arms["<arm>@<category>"]`: the same restricted to one category (the separator is `@`);
 *  - `paired_deltas`: `{a, b = "full_page", mean_delta, ci95, p_value}` for every arm against the full page, overall
 *    and per category (`pruned_model@docs` against `full_page@docs`); `mean_delta` is a FRACTION (0.03 = 3 pp), the
 *    decision script multiplies by 100; `ci95` is the percentile interval of the domain bootstrap, `p_value` McNemar exact;
 *  - `evidence_retention.by_stratum[category] = { mean, n_questions }` on every page-showing arm.
 * Closed-book contamination: pages whose closed-book accuracy is above `flag_above` are listed, and the arms
 * `<arm>~nocb` (full_page, pruned_model, pruned_router, oracle without them) repeat the analysis.
 */

export type Downstream = NonNullable<EvalReport["downstream"]>;
type Arm = Downstream["arms"][string];

export const CATEGORY_SEPARATOR = "@";
export const NO_CB_SUFFIX = "~nocb";
export const CLOSED_BOOK_FLAG_ABOVE = 0.3;

export interface ArmScores {
  /** task id -> 1 right, 0 wrong. Only the tasks the arm answered. */
  correct: Map<string, 0 | 1>;
  rows: AnswerRow[];
  /** USD the judge cost on each of this arm's answers, by task id (absent = not judged). */
  judgeCost: Map<string, number>;
}

export interface ReportInput {
  taskSet: QaTaskSet;
  arms: Map<string, ArmScores>;
  /** Retention per arm (page-showing arms), by task id. */
  retention: Map<string, Map<string, Retention>>;
  respondent: { model: string; prompt_sha256: Sha256 };
  judge: { kind: "llm" | "exact" | "human"; model?: string; rubric_sha256?: Sha256; human_agreement?: number };
  bootstrap: BootstrapConfig;
  closedBookFlagAbove?: number;
}

const unit01 = (x: number): number => Math.min(1, Math.max(0, x));

function armOf(tasks: readonly QaTaskSet["tasks"][number][], s: ArmScores, b: BootstrapConfig, rets: Map<string, Retention> | undefined): Arm {
  const answered = tasks.filter((t) => s.correct.has(t.id));
  const values = answered.map((t) => s.correct.get(t.id) as number);
  const keys = answered.map((t) => groupKeyOf(t.group_id));
  const { mean, ci95 } = clusterMeanCi(values, keys, b);
  const ids = new Set(answered.map((t) => t.id));
  const mine = s.rows.filter((r) => ids.has(r.task_id));
  const cost = mine.reduce((n, r) => n + r.cost_usd + (s.judgeCost.get(r.task_id) ?? 0), 0);
  const arm: Arm = {
    n: answered.length,
    score_mean: unit01(mean),
    score_ci95: [unit01(ci95[0]), unit01(ci95[1])],
    tokens_in_mean: mine.length === 0 ? 0 : mine.reduce((n, r) => n + r.input_tokens, 0) / mine.length,
    cost_usd: cost,
  };
  if (rets !== undefined) arm.evidence_retention = retentionOf(answered, rets, b);
  return arm;
}

function retentionOf(tasks: readonly QaTaskSet["tasks"][number][], rets: Map<string, Retention>, b: BootstrapConfig): NonNullable<Arm["evidence_retention"]> {
  const have = tasks.filter((t) => rets.has(t.id));
  const flags = have.map((t) => ((rets.get(t.id) as Retention).retained ? 1 : 0));
  const ci = clusterMeanCi(flags, have.map((t) => groupKeyOf(t.group_id)), b);
  const by: Record<string, { mean: number; n_questions: number }> = {};
  for (const stratum of [...new Set(have.map((t) => t.stratum))].sort()) {
    const sub = have.filter((t) => t.stratum === stratum);
    by[stratum] = { mean: unit01(sub.filter((t) => (rets.get(t.id) as Retention).retained).length / sub.length), n_questions: sub.length };
  }
  return {
    mean: unit01(ci.mean),
    ci95: [unit01(ci.ci95[0]), unit01(ci.ci95[1])],
    n_questions: have.length,
    token_fraction_mean: unit01(have.reduce((n, t) => n + (rets.get(t.id) as Retention).token_fraction, 0) / Math.max(1, have.length)),
    by_stratum: by,
  };
}

/** Paired delta of arm `a` against arm `b` over the tasks both answered (null when there is no common task). */
function delta(tasks: readonly QaTaskSet["tasks"][number][], a: ArmScores, b: ArmScores, an: string, bn: string, cfg: BootstrapConfig): Downstream["paired_deltas"][number] | null {
  const common = tasks.filter((t) => a.correct.has(t.id) && b.correct.has(t.id));
  if (common.length === 0) return null;
  const r = pairedDelta(common.map((t) => a.correct.get(t.id) as 0 | 1), common.map((t) => b.correct.get(t.id) as 0 | 1), common.map((t) => groupKeyOf(t.group_id)), cfg);
  return { a: an, b: bn, mean_delta: r.mean_delta, ci95: r.ci95, p_value: r.p_value };
}

export interface ClosedBookAnalysis {
  flag_above: number;
  /** Per page: share of its questions the closed-book arm got right. */
  per_page: Array<{ group_id: string; stratum: string; n: number; accuracy: number; flagged: boolean }>;
  flagged: string[];
}

export function closedBookAnalysis(taskSet: QaTaskSet, cb: ArmScores | undefined, flagAbove: number): ClosedBookAnalysis | null {
  if (cb === undefined) return null;
  const per = new Map<string, { n: number; right: number; stratum: string }>();
  for (const t of taskSet.tasks) {
    const v = cb.correct.get(t.id);
    if (v === undefined) continue;
    const p = per.get(t.group_id) ?? { n: 0, right: 0, stratum: t.stratum };
    p.n++;
    p.right += v;
    per.set(t.group_id, p);
  }
  const per_page = [...per.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([group_id, p]) => ({ group_id, stratum: p.stratum, n: p.n, accuracy: p.right / p.n, flagged: p.right / p.n > flagAbove }));
  return { flag_above: flagAbove, per_page, flagged: per_page.filter((p) => p.flagged).map((p) => p.group_id) };
}

const restrict = (s: ArmScores, keep: (taskId: string) => boolean): ArmScores => ({
  correct: new Map([...s.correct].filter(([id]) => keep(id))),
  rows: s.rows.filter((r) => keep(r.task_id)),
  judgeCost: new Map([...s.judgeCost].filter(([id]) => keep(id))),
});

export function buildDownstream(i: ReportInput): { downstream: Downstream; closedBook: ClosedBookAnalysis | null } {
  const tasks = i.taskSet.tasks;
  const strata = [...new Set(tasks.map((t) => t.stratum))].sort();
  const arms: Downstream["arms"] = {};
  const paired: Downstream["paired_deltas"] = [];
  const names = [...i.arms.keys()];
  const full = i.arms.get(FULL_PAGE);

  const addArm = (name: string, s: ArmScores, subset: readonly QaTaskSet["tasks"][number][], rets?: Map<string, Retention>): void => {
    if (subset.some((t) => s.correct.has(t.id))) arms[name] = armOf(subset, s, i.bootstrap, rets);
  };
  for (const name of names) {
    const s = i.arms.get(name) as ArmScores;
    addArm(name, s, tasks, i.retention.get(name));
    for (const c of strata) addArm(`${name}${CATEGORY_SEPARATOR}${c}`, s, tasks.filter((t) => t.stratum === c));
  }
  if (full !== undefined) {
    for (const name of names) {
      if (name === FULL_PAGE) continue;
      const s = i.arms.get(name) as ArmScores;
      const d = delta(tasks, s, full, name, FULL_PAGE, i.bootstrap);
      if (d !== null) paired.push(d);
      for (const c of strata) {
        const sub = tasks.filter((t) => t.stratum === c);
        const dc = delta(sub, s, full, `${name}${CATEGORY_SEPARATOR}${c}`, `${FULL_PAGE}${CATEGORY_SEPARATOR}${c}`, i.bootstrap);
        if (dc !== null) paired.push(dc);
      }
    }
  }

  // Closed-book contamination: the same comparisons without the pages the model answers from memory.
  const cb = closedBookAnalysis(i.taskSet, i.arms.get(CLOSED_BOOK), i.closedBookFlagAbove ?? CLOSED_BOOK_FLAG_ABOVE);
  if (cb !== null && cb.flagged.length > 0 && cb.flagged.length < cb.per_page.length && full !== undefined) {
    const flagged = new Set(cb.flagged);
    const keepId = (id: string): boolean => !flagged.has((tasks.find((t) => t.id === id) as QaTaskSet["tasks"][number]).group_id);
    const kept = tasks.filter((t) => !flagged.has(t.group_id));
    const sub = (n: string): ArmScores | undefined => {
      const s = i.arms.get(n);
      return s === undefined ? undefined : restrict(s, keepId);
    };
    for (const name of [FULL_PAGE, PRUNED_MODEL, PRUNED_ROUTER, ORACLE]) {
      const s = sub(name);
      if (s === undefined) continue;
      addArm(`${name}${NO_CB_SUFFIX}`, s, kept);
    }
    const f = sub(FULL_PAGE) as ArmScores;
    for (const name of [PRUNED_MODEL, PRUNED_ROUTER, ORACLE]) {
      const s = sub(name);
      if (s === undefined) continue;
      const d = delta(kept, s, f, `${name}${NO_CB_SUFFIX}`, `${FULL_PAGE}${NO_CB_SUFFIX}`, i.bootstrap);
      if (d !== null) paired.push(d);
    }
  }

  const downstream: Downstream = {
    task_set_id: i.taskSet.task_set_id,
    bootstrap: { resamples: i.bootstrap.resamples, seed: i.bootstrap.seed, cluster_by: "group_key", method: "percentile", stratified: false },
    llm: { model: i.respondent.model, prompt_sha256: i.respondent.prompt_sha256 },
    judge: {
      kind: i.judge.kind,
      ...(i.judge.model !== undefined ? { model: i.judge.model } : {}),
      ...(i.judge.rubric_sha256 !== undefined ? { rubric_sha256: i.judge.rubric_sha256 } : {}),
      ...(i.judge.human_agreement !== undefined ? { human_agreement: i.judge.human_agreement } : {}),
    },
    arms,
    paired_deltas: paired,
  };
  return { downstream, closedBook: cb };
}
