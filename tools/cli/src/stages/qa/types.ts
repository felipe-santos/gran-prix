import type { Sha256 } from "@gran-prix/contracts";
import type { CandidateRecord, PageRef, RejectionStats } from "./generate.js";
import type { recordedParams } from "./model-params.js";

/** Documents the QA stages pass to each other (Bundle artifacts). Plain JSON, canonical on write. */

export const CANDIDATES_FORMAT = "gran-prix.qa-candidates" as const;
export const REVIEW_FORMAT = "gran-prix.qa-review" as const;
export const JUDGE_REVIEW_FORMAT = "gran-prix.qa-judge-review" as const;
export const ANSWERS_FORMAT = "gran-prix.qa-answers" as const;
export const TASKSET_SUMMARY_FORMAT = "gran-prix.qa-taskset-summary" as const;

export type RecordedParams = ReturnType<typeof recordedParams>;

export interface CandidatePage extends PageRef {
  /** `ok`: candidates generated and validated. `excluded`: the page could not be used (`reason`). `failed`: the generator's answer was invalid twice. `dry_run`: planned only. `budget_stopped`: the ledger stopped before it. */
  status: "ok" | "excluded" | "failed" | "dry_run" | "budget_stopped";
  reason?: string;
  d2_sha256?: string;
  candidates: CandidateRecord[];
}

export interface CandidatesDoc {
  format: typeof CANDIDATES_FORMAT;
  format_version: "1.0.0";
  /** sha256 of the canonical document without this field: the review export must carry it. */
  candidates_id: Sha256;
  dataset_id: Sha256 | null;
  generator: {
    provider: string;
    model: string;
    prompt_id: string;
    prompt_sha256: Sha256;
    request: RecordedParams;
    source: string;
    converter: string | null;
    collapsed: string;
  };
  selection: { seed: string; quota: Record<string, number>; by_stratum: Record<string, { wanted: number; got: number; test: number; dev: number; available: number }>; default_split: string };
  validation: { min_quote_chars: number; max_quote_chars: number; rejection: RejectionStats };
  pages: CandidatePage[];
}

export interface ReviewDecision {
  group_id: string;
  rank: number;
  answers_from_page: boolean | null;
  unique: boolean | null;
  correct: boolean | null;
}

export interface ReviewExport {
  format: typeof REVIEW_FORMAT;
  format_version: "1.0.0";
  candidates_id: Sha256;
  reviewer: string;
  decisions: ReviewDecision[];
}

export type ArmId = string;

/** One respondent answer: a (task, arm) pair. */
export interface AnswerRow {
  task_id: string;
  arm: ArmId;
  /** The response text. */
  text: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  stop_reason?: string;
  /** sha256 of the arm's page text the answer saw (null for closed_book); links the answer to what retention is measured on. */
  page_sha256: Sha256 | null;
  error?: string;
}

export interface AnswersDoc {
  format: typeof ANSWERS_FORMAT;
  format_version: "1.0.0";
  respondent: string;
  task_set_id: Sha256;
  model: string;
  prompt_id: string;
  prompt_sha256: Sha256;
  request: RecordedParams;
  max_tokens: number;
  /** Arms asked, in order, and the arms the cut order removed (with the step that removed them). */
  arms: ArmId[];
  cut: Array<{ step: string; arms: ArmId[]; reason: string }>;
  /** `complete`: every (task, arm) of `arms` is answered (arms the cut order removed are not in `arms`). `partial`: the budget stopped it or R2 was cut part-way. `dropped`: R2 was cut entirely (step 4). */
  status: "complete" | "partial" | "dropped" | "dry_run";
  rows: AnswerRow[];
}
