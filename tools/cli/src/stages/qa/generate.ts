import { sha256Hex } from "@gran-prix/contracts";
import type { CallModel, CallPlan } from "./call.js";
import {
  CANDIDATE_KINDS,
  GENERATOR_PROMPT_SHA256,
  GENERATOR_SCHEMA,
  GENERATOR_SYSTEM,
  candidatesCorrection,
  generatorUser,
  parseCandidates,
  type CandidateKind,
  type RawCandidate,
} from "./prompts.js";
import { checkCandidate, REJECT_REASONS, type CandidateCheck, type Evidence, type GoldClass, type RejectReason, type ValidationContext } from "./validators.js";
import type { UnitSpan } from "./locate.js";

/** Candidate generation (protocol 9): page selection, the generator call, and the automatic validation of what it returns. */

export type SplitName = "train" | "val" | "test";

export interface PageRef {
  group_id: string;
  group_key: string;
  snapshot_id: string;
  stratum: string;
  split: SplitName;
  /** `frozen_model`: a test page scored by the final model. `oof`: a dev page scored out-of-fold. */
  prediction: "frozen_model" | "oof";
}

export const hex12Of = (snapshotId: string): string => snapshotId.slice("sha256:".length, "sha256:".length + 12);

/** Default quota of pages per category (protocol 9). */
export const DEFAULT_PAGE_QUOTA: Readonly<Record<string, number>> = { article: 10, product: 18, docs: 18, forum: 18, landing: 18, spa: 18 };

export interface PageSelection {
  selected: PageRef[];
  /** Per category: pages wanted, pages available, test pages and dev pages taken. */
  by_stratum: Record<string, { wanted: number; got: number; test: number; dev: number; available: number }>;
}

/**
 * "100 = every test page + dev pages to complete the quota per category, drawn by the seed": per category the test
 * pages come first (all of them, up to the quota), then dev pages (train + val) up to the quota. The draw is the order
 * of `sha256(seed|group_id)`: deterministic, independent of the order the pages arrive in. Dev pages are predicted
 * out-of-fold, test pages by the frozen model. Categories absent from `quota` are not selected.
 */
export function selectPages(pages: readonly Omit<PageRef, "prediction">[], quota: Readonly<Record<string, number>>, seed: string): PageSelection {
  const rank = (p: { group_id: string }): string => sha256Hex(`${seed}|${p.group_id}`);
  const byRank = (a: { group_id: string }, b: { group_id: string }): number => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0);
  const selected: PageRef[] = [];
  const by: PageSelection["by_stratum"] = {};
  for (const stratum of Object.keys(quota).sort()) {
    const want = quota[stratum] as number;
    const all = pages.filter((p) => p.stratum === stratum);
    const test = all.filter((p) => p.split === "test").sort(byRank);
    const dev = all.filter((p) => p.split !== "test").sort(byRank);
    const takenTest = test.slice(0, want);
    const takenDev = dev.slice(0, Math.max(0, want - takenTest.length));
    for (const p of takenTest) selected.push({ ...p, prediction: "frozen_model" });
    for (const p of takenDev) selected.push({ ...p, prediction: "oof" });
    by[stratum] = { wanted: want, got: takenTest.length + takenDev.length, test: takenTest.length, dev: takenDev.length, available: all.length };
  }
  return { selected, by_stratum: by };
}

export function generatorPlan(model: CallModel, stratum: string, d2: string, maxTokens: number): CallPlan<RawCandidate[]> {
  return {
    model,
    system: GENERATOR_SYSTEM,
    promptSha256: GENERATOR_PROMPT_SHA256,
    messages: [{ role: "user", content: generatorUser(stratum, d2) }],
    maxTokens,
    contract: "qa.generate@1",
    schema: GENERATOR_SCHEMA,
    parse: parseCandidates,
    correction: candidatesCorrection,
  };
}

export interface CandidateRecord {
  rank: number;
  kind: CandidateKind;
  question: string;
  answer: string;
  answer_variants: string[];
  quote: string;
  auto: { status: "pass" | "reject"; reasons: RejectReason[]; advisory: string[] };
  evidence?: Evidence;
}

/** The candidates of a page in rank order, each with its automatic verdict (rejected ones are kept, for the record). */
export function validateCandidates(raw: readonly RawCandidate[], d2: string, spans: readonly UnitSpan[], gold: ReadonlyMap<number, GoldClass>, limits: { min: number; max: number }): CandidateRecord[] {
  const ctx: ValidationContext = { d2, spans, gold, seenQuestions: new Set(), minQuoteChars: limits.min, maxQuoteChars: limits.max };
  return raw.map((c, i) => {
    const check: CandidateCheck = checkCandidate(c, ctx);
    return {
      rank: i + 1,
      kind: c.kind,
      question: c.question,
      answer: c.answer,
      answer_variants: c.answer_variants,
      quote: c.evidence_quote,
      auto: { status: check.status, reasons: check.reasons, advisory: check.advisory },
      ...(check.evidence ? { evidence: check.evidence } : {}),
    };
  });
}

export interface RejectionStats {
  n_candidates: number;
  n_rejected: number;
  rate: number;
  by_reason: Record<string, number>;
  by_kind: Record<string, { n: number; rejected: number }>;
}

/** Rejection rate of the automatic validators and its causes. */
export function rejectionStats(lists: readonly (readonly CandidateRecord[])[]): RejectionStats {
  const by_reason: Record<string, number> = Object.fromEntries(REJECT_REASONS.map((r) => [r, 0]));
  const by_kind: RejectionStats["by_kind"] = Object.fromEntries(CANDIDATE_KINDS.map((k) => [k, { n: 0, rejected: 0 }]));
  let n = 0;
  let rej = 0;
  for (const list of lists) {
    for (const c of list) {
      n++;
      (by_kind[c.kind] as { n: number; rejected: number }).n++;
      if (c.auto.status === "reject") {
        rej++;
        (by_kind[c.kind] as { n: number; rejected: number }).rejected++;
        for (const r of c.auto.reasons) by_reason[r] = (by_reason[r] ?? 0) + 1;
      }
    }
  }
  return { n_candidates: n, n_rejected: rej, rate: n === 0 ? 0 : rej / n, by_reason, by_kind };
}
