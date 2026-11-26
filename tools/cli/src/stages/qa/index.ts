import type { StagePlugin } from "../../stage.js";
import { createAnswerStage } from "./stage-answer.js";
import { createGenerateStage } from "./stage-generate.js";
import { createScoreStage } from "./stage-score.js";
import { tasksetStage } from "./stage-taskset.js";
import type { QaStageDeps } from "./stage-common.js";

/**
 * The downstream QA tool (E3.4, protocol 9, gate G3): four stages, all offline-testable with a fake transport.
 *
 *   ts:qa.generate  D2 + gold -> 7 candidates per page, automatic validators, review.html     (cached-external)
 *   ts:qa.taskset   candidates + the human review export -> the qa-task-set                    (pure)
 *   ts:qa.answer    the arms x the questions, one respondent (R1 or R2)                        (cached-external)
 *   ts:qa.score     facts + LLM judge + human sample -> the downstream EvalReport for `decide` (cached-external)
 *
 * `createQaStages(deps)` builds them over another transport (tests pass a fake); the registered ones use the real one,
 * which needs ANTHROPIC_API_KEY only when a call is actually due.
 */
export function createQaStages(deps?: QaStageDeps): StagePlugin[] {
  const generate = createGenerateStage(deps);
  return [generate, tasksetStage, createAnswerStage(deps), createScoreStage(deps)];
}

export const QA_STAGES: readonly StagePlugin[] = createQaStages();

export { CUT_ORDER, CUT_TRIGGER, planCuts } from "./cuts.js";
export { QaFakeTransport, QaAnthropicTransport, type QaRequest, type QaTransport } from "./transport.js";
export type { QaStageDeps } from "./stage-common.js";
