import { contractId, type QaTaskSet, type Sha256 } from "@gran-prix/contracts";
import type { CandidateRecord } from "./generate.js";
import { CANDIDATE_KINDS, KIND_QUOTA, type CandidateKind } from "./prompts.js";
import { REVIEW_FORMAT, type CandidatePage, type CandidatesDoc, type ReviewDecision, type ReviewExport } from "./types.js";

/**
 * The import of the human review: candidates + decisions -> the final `qa-task-set` (protocol 9). Per page and per
 * kind, the candidates that passed the automatic validators are taken IN RANK ORDER; a human `accepted` fills a slot
 * of the kind's quota (2 main, 2 category, 1 support), a human `rejected` is replaced by the next candidate of the kind,
 * an undecided one stops the page (the review is incomplete). The rejection rate counts what had to be looked at to fill
 * the quotas: accepted + every candidate (automatic or human) rejected on the way.
 */

export type Decision = "accepted" | "rejected" | "undecided";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates the JSON the review page exports; refuses a review of another candidates document. */
export function parseReviewExport(json: unknown, candidates: CandidatesDoc): ReviewExport {
  if (!isObj(json) || json["format"] !== REVIEW_FORMAT) throw new Error(`the review file is not a ${REVIEW_FORMAT} export`);
  if (json["candidates_id"] !== candidates.candidates_id) {
    throw new Error(`the review was made on candidates ${String(json["candidates_id"])}, not on ${candidates.candidates_id}: export it again from the review page of THIS candidates document`);
  }
  const list = json["decisions"];
  if (!Array.isArray(list)) throw new Error("the review file has no decisions list");
  const known = new Set(candidates.pages.flatMap((p) => p.candidates.map((c) => `${p.group_id}|${c.rank}`)));
  const seen = new Set<string>();
  const decisions: ReviewDecision[] = list.map((d, i) => {
    if (!isObj(d) || typeof d["group_id"] !== "string" || !Number.isInteger(d["rank"])) throw new Error(`review decision ${i + 1}: needs group_id and an integer rank`);
    const key = `${d["group_id"]}|${String(d["rank"])}`;
    if (!known.has(key)) throw new Error(`review decision ${i + 1}: ${key} is not a candidate of this document`);
    if (seen.has(key)) throw new Error(`review decision ${i + 1}: ${key} appears twice`);
    seen.add(key);
    const flag = (f: string): boolean | null => {
      const v = d[f];
      if (v === null || v === undefined) return null;
      if (typeof v !== "boolean") throw new Error(`review decision ${i + 1}: ${f} must be true, false or null`);
      return v;
    };
    return { group_id: d["group_id"], rank: d["rank"] as number, answers_from_page: flag("answers_from_page"), unique: flag("unique"), correct: flag("correct") };
  });
  return { format: REVIEW_FORMAT, format_version: "1.0.0", candidates_id: candidates.candidates_id, reviewer: typeof json["reviewer"] === "string" ? json["reviewer"] : "", decisions };
}

/** accepted = all three answers yes; rejected = any no; otherwise undecided. */
export function decisionOf(d: ReviewDecision | undefined): Decision {
  if (d === undefined) return "undecided";
  if (d.answers_from_page === false || d.unique === false || d.correct === false) return "rejected";
  if (d.answers_from_page === true && d.unique === true && d.correct === true) return "accepted";
  return "undecided";
}

export interface PageOutcome {
  group_id: string;
  stratum: string;
  accepted: Array<{ candidate: CandidateRecord; by: "human" | "auto" }>;
  /** Candidates looked at to fill the quotas, and how many of them were rejected (automatically or by the human). */
  considered: number;
  rejected: number;
  /** Quota slots left empty by kind: `short` (the candidates ran out) or `incomplete` (an undecided candidate stopped it). */
  missing: Array<{ kind: CandidateKind; slots: number; why: "short" | "incomplete" }>;
}

export function selectForPage(page: CandidatePage, decisions: ReadonlyMap<string, ReviewDecision>, mode: "human" | "auto"): PageOutcome {
  const out: PageOutcome = { group_id: page.group_id, stratum: page.stratum, accepted: [], considered: 0, rejected: 0, missing: [] };
  for (const kind of ["main", "category", "support"] as const) {
    const quota = KIND_QUOTA[kind];
    const list = page.candidates.filter((c) => c.kind === kind);
    let filled = 0;
    let lastLooked = 0; // index into `list` of the last candidate examined, plus one
    let stopped: "incomplete" | undefined;
    for (let i = 0; i < list.length && filled < quota; i++) {
      const c = list[i] as CandidateRecord;
      if (c.auto.status === "reject") {
        lastLooked = i + 1;
        continue;
      }
      const d: Decision = mode === "auto" ? "accepted" : decisionOf(decisions.get(`${page.group_id}|${c.rank}`));
      if (d === "undecided") {
        stopped = "incomplete";
        break;
      }
      lastLooked = i + 1;
      if (d === "accepted") {
        out.accepted.push({ candidate: c, by: mode });
        filled++;
      }
    }
    const looked = list.slice(0, lastLooked);
    const accepted = looked.filter((c) => out.accepted.some((a) => a.candidate === c)).length;
    out.considered += looked.length;
    out.rejected += looked.length - accepted;
    if (filled < quota) out.missing.push({ kind, slots: quota - filled, why: stopped ?? "short" });
  }
  return out;
}

export interface TaskSetParams {
  candidates: CandidatesDoc;
  decisions: readonly ReviewDecision[];
  /** `auto`: no human review (a dry rehearsal): every candidate that passed the validators is accepted, `human_reviewed` is false. */
  mode: "human" | "auto";
  allowIncomplete: boolean;
  datasetId?: Sha256 | undefined;
}

export interface TaskSetResult {
  /** Without `provenance`. */
  doc: Omit<QaTaskSet, "provenance">;
  outcomes: PageOutcome[];
  dropped_pages: Array<{ group_id: string; stratum: string; why: string }>;
  incomplete_pages: string[];
}

const KIND_ORDER = new Map<CandidateKind, number>(CANDIDATE_KINDS.map((k, i) => [k, i]));

export function buildTaskSet(p: TaskSetParams): TaskSetResult {
  const decisions = new Map(p.decisions.map((d) => [`${d.group_id}|${d.rank}`, d]));
  const outcomes: PageOutcome[] = [];
  const dropped: TaskSetResult["dropped_pages"] = [];
  for (const page of p.candidates.pages) {
    if (page.status !== "ok") {
      dropped.push({ group_id: page.group_id, stratum: page.stratum, why: `${page.status}${page.reason ? `: ${page.reason}` : ""}` });
      continue;
    }
    outcomes.push(selectForPage(page, decisions, p.mode));
  }
  const incomplete = outcomes.filter((o) => o.missing.some((m) => m.why === "incomplete")).map((o) => o.group_id);
  if (incomplete.length > 0 && !p.allowIncomplete) {
    throw new Error(`the review is incomplete on ${incomplete.length} page(s) (first: ${incomplete[0]}): finish them in the review page or set allow_incomplete`);
  }
  const used = outcomes.filter((o) => o.accepted.length > 0);
  for (const o of outcomes.filter((x) => x.accepted.length === 0)) dropped.push({ group_id: o.group_id, stratum: o.stratum, why: "no accepted candidate" });
  if (used.length === 0) throw new Error("no candidate was accepted: the task set would be empty");

  const pageOf = new Map(p.candidates.pages.map((pg) => [pg.group_id, pg]));
  const tasks: QaTaskSet["tasks"] = [];
  for (const o of [...used].sort((a, b) => (a.stratum < b.stratum ? -1 : a.stratum > b.stratum ? 1 : a.group_id < b.group_id ? -1 : a.group_id > b.group_id ? 1 : 0))) {
    const ordered = [...o.accepted].sort((a, b) => (KIND_ORDER.get(a.candidate.kind) as number) - (KIND_ORDER.get(b.candidate.kind) as number) || a.candidate.rank - b.candidate.rank);
    for (const { candidate: c, by } of ordered) {
      const ev = c.evidence;
      if (ev === undefined) throw new Error(`candidate ${o.group_id} #${c.rank} passed validation without evidence`);
      tasks.push({
        id: `${o.group_id}/r${c.rank}`,
        group_id: o.group_id,
        stratum: o.stratum,
        kind: c.kind,
        question: c.question,
        answer: c.answer,
        answer_variants: c.answer_variants,
        evidence: { unit_ids: ev.unit_ids, quote: c.quote, class: ev.class },
        validation: { status: "accepted", by, candidate_rank: c.rank },
      });
    }
  }
  const nConsidered = used.reduce((n, o) => n + o.considered, 0);
  const nRejected = used.reduce((n, o) => n + o.rejected, 0);
  const humanReviewed = p.mode === "human";
  const g = p.candidates.generator;
  const base = {
    format: "gran-prix.qa-task-set" as const,
    format_version: "1.0.0" as const,
    ...(p.datasetId !== undefined ? { dataset_id: p.datasetId } : p.candidates.dataset_id !== null ? { dataset_id: p.candidates.dataset_id } : {}),
    generator: { model: g.model, prompt_sha256: g.prompt_sha256, source: g.source, ...(g.converter !== null ? { converter: g.converter } : {}) },
    pages: used.map((o) => {
      const pg = pageOf.get(o.group_id) as CandidatePage;
      return { group_id: pg.group_id, snapshot_id: pg.snapshot_id as Sha256, stratum: pg.stratum, split: pg.split, prediction: pg.prediction };
    }),
    tasks,
    review: { n_candidates: nConsidered, n_accepted: tasks.length, n_rejected: nRejected, rejection_rate: nConsidered === 0 ? 0 : nRejected / nConsidered, human_reviewed: humanReviewed },
  };
  const task_set_id = contractId("qa-task-set", base as unknown as Record<string, unknown>);
  return { doc: { ...base, task_set_id } as unknown as Omit<QaTaskSet, "provenance">, outcomes, dropped_pages: dropped, incomplete_pages: incomplete };
}
