/**
 * The cut order of protocol 5.6, pre-registered: "se o ledger chegar a 90% do teto: (1) bracos de baseline do R1;
 * (2) o juiz LLM vira humano em mais casos; (3) o R2 perde o braco do roteador; (4) queda do R2 inteiro (G3 passa a
 * depender so do R1, com aviso)".
 *
 * The rule, as code (no stage re-implements it):
 *  - nothing is cut while spent/cap is below the trigger (0.9);
 *  - at or above it, the steps are applied IN THAT ORDER, each one only while the work still to be done would not fit
 *    in what is left of the cap; a step that frees nothing in the calling stage (the R2 router arm seen from the R1
 *    stage) is skipped without being "used", and a later step is never taken before an earlier one that could still
 *    free money;
 *  - a stage can only cut what it owns: the answer stage owns steps 1, 3 and 4, the score stage owns step 2. The report
 *    of each stage lists the steps applied and why.
 */

export const CUT_TRIGGER = 0.9;

export type CutStep = "r1_baseline_arms" | "judge_to_human" | "r2_router_arm" | "r2_all";
export const CUT_ORDER: readonly CutStep[] = ["r1_baseline_arms", "judge_to_human", "r2_router_arm", "r2_all"];

export const CUT_TEXT: Readonly<Record<CutStep, string>> = {
  r1_baseline_arms: "(1) the baseline arms of R1 (readability, trafilatura, defuddle) are not asked",
  judge_to_human: "(2) the LLM judge stops: the answers it would have graded go to the human queue",
  r2_router_arm: "(3) R2 loses the router arm",
  r2_all: "(4) R2 is dropped entirely: G3 then rests on R1 alone, with a warning",
};

export interface CutInput {
  capUSD: number;
  /** Committed + reserved so far (the ledger's total). */
  spentUSD: number;
  /** Estimated cost of the work this stage still has to do (worst case is not needed: the expected cost). */
  pendingUSD: number;
  /** What each step the stage owns would free of `pendingUSD`. Absent or 0 = the stage has nothing to cut there. */
  frees: Partial<Record<CutStep, number>>;
  trigger?: number;
}

export interface CutPlan {
  triggered: boolean;
  spent_fraction: number;
  /** Steps applied, in order. */
  applied: CutStep[];
  /** Cost still to do after the cuts. */
  pending_after_usd: number;
  /** Whether what is left of the work fits in what is left of the cap. */
  fits: boolean;
}

export function planCuts(i: CutInput): CutPlan {
  const trigger = i.trigger ?? CUT_TRIGGER;
  const fraction = i.capUSD > 0 ? i.spentUSD / i.capUSD : 1;
  const remaining = Math.max(0, i.capUSD - i.spentUSD);
  const applied: CutStep[] = [];
  let pending = i.pendingUSD;
  if (fraction >= trigger) {
    for (const step of CUT_ORDER) {
      if (pending <= remaining) break;
      const f = i.frees[step] ?? 0;
      if (f <= 0) continue;
      applied.push(step);
      pending -= f;
    }
  }
  return { triggered: fraction >= trigger, spent_fraction: fraction, applied, pending_after_usd: Math.max(0, pending), fits: pending <= remaining };
}
