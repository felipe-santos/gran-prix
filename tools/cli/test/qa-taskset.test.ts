// QA tool, the import of the human review: quotas of 2 main + 2 category + 1 support, replacement by the next candidate of
// the kind in order, the rejection rate, incomplete reviews, stale files, and the final qa-task-set against its contract.
import { assertValid, type Sha256 } from "@gran-prix/contracts";
import { describe, expect, it } from "vitest";
import type { CandidateRecord } from "../src/stages/qa/generate.js";
import { CANDIDATE_KINDS } from "../src/stages/qa/prompts.js";
import { buildTaskSet, decisionOf, parseReviewExport } from "../src/stages/qa/taskset.js";
import { CANDIDATES_FORMAT, REVIEW_FORMAT, type CandidatePage, type CandidatesDoc, type ReviewDecision } from "../src/stages/qa/types.js";
import { HASH } from "./qa-fixtures.js";

const ID = HASH("e");

function cands(group: string, rejectAuto: number[] = []): CandidateRecord[] {
  return CANDIDATE_KINDS.map((kind, i) => ({
    rank: i + 1,
    kind,
    question: `${group} question ${i + 1}?`,
    answer: `answer ${i + 1}`,
    answer_variants: [],
    quote: `${group} quote ${i + 1}`,
    auto: rejectAuto.includes(i + 1) ? { status: "reject", reasons: ["quote_not_found"], advisory: [] } : { status: "pass", reasons: [], advisory: [] },
    ...(rejectAuto.includes(i + 1) ? {} : { evidence: { unit_ids: [i + 2], unit_classes: [kind === "support" ? "support" : "main"], class: kind === "support" ? "support" : "main", offset: 0 } }),
  })) as CandidateRecord[];
}

function page(group: string, stratum: string, rejectAuto: number[] = [], status: CandidatePage["status"] = "ok"): CandidatePage {
  return { group_id: `${group}#${"0".repeat(11)}${group.length}`, group_key: group, snapshot_id: HASH("1"), stratum, split: "test", prediction: "frozen_model", status, candidates: status === "ok" ? cands(group, rejectAuto) : [] };
}

function doc(pages: CandidatePage[]): CandidatesDoc {
  return {
    format: CANDIDATES_FORMAT,
    format_version: "1.0.0",
    candidates_id: ID,
    dataset_id: null,
    generator: { provider: "fake", model: "gen", prompt_id: "p", prompt_sha256: HASH("a"), request: { send_temperature: false, thinking: "off", thinking_wire: "omitted", effort: null, caps_source: "t" }, source: "D2 full-page markdown", converter: "conv@1", collapsed: "exclude" },
    selection: { seed: "s", quota: {}, by_stratum: {}, default_split: "test" },
    validation: { min_quote_chars: 8, max_quote_chars: 600, rejection: { n_candidates: 0, n_rejected: 0, rate: 0, by_reason: {}, by_kind: {} } },
    pages,
  };
}

const accept = (g: string, ranks: number[]): ReviewDecision[] => ranks.map((rank) => ({ group_id: g, rank, answers_from_page: true, unique: true, correct: true }));
const reject = (g: string, ranks: number[]): ReviewDecision[] => ranks.map((rank) => ({ group_id: g, rank, answers_from_page: true, unique: false, correct: null }));
const withProv = (d: object): unknown => ({ ...d, provenance: { produced_by: { run_id: "x", stage_id: "x", kind: "evaluate", impl: "x", params_sha256: HASH("b"), cache_key: HASH("c") }, inputs: [], pipeline_spec_id: HASH("d"), tool_versions: { gp_cli: "0", node: "0" }, created_at: "1970-01-01T00:00:00Z", duration_ms: 0 } });

describe("decisions", () => {
  it("accepted = all three yes, rejected = any no, otherwise undecided", () => {
    const d = (a: boolean | null, u: boolean | null, c: boolean | null): ReviewDecision => ({ group_id: "g", rank: 1, answers_from_page: a, unique: u, correct: c });
    expect(decisionOf(d(true, true, true))).toBe("accepted");
    expect(decisionOf(d(true, false, null))).toBe("rejected");
    expect(decisionOf(d(null, null, false))).toBe("rejected");
    expect(decisionOf(d(true, null, true))).toBe("undecided");
    expect(decisionOf(undefined)).toBe("undecided");
  });
});

describe("the task set from the review", () => {
  const A = page("docs-a.example", "docs");
  const g = A.group_id;

  it("the primary candidates fill the quotas: 2 main, 2 category, 1 support, in rank order; the contract holds", () => {
    const r = buildTaskSet({ candidates: doc([A]), decisions: accept(g, [1, 2, 3, 4, 5]), mode: "human", allowIncomplete: false });
    const tasks = r.doc.tasks;
    expect(tasks.map((t) => [t.kind, t.validation.candidate_rank])).toEqual([["main", 1], ["main", 3], ["category", 2], ["category", 4], ["support", 5]]);
    expect(tasks.every((t) => t.validation.by === "human" && t.validation.status === "accepted")).toBe(true);
    expect(tasks[0]!.evidence).toEqual({ unit_ids: [2], quote: "docs-a.example quote 1", class: "main" });
    expect(tasks.find((t) => t.kind === "support")!.evidence.class).toBe("support");
    expect(r.doc.review).toEqual({ n_candidates: 5, n_accepted: 5, n_rejected: 0, rejection_rate: 0, human_reviewed: true });
    assertValid("qa-task-set", withProv(r.doc)); // id, counts, answer length: every invariant of the contract
    expect(r.doc.pages).toHaveLength(1);
  });

  it("a rejected candidate is replaced by the next one of its kind, in order, and the rate counts what was looked at", () => {
    // category rank 2 rejected by the human -> rank 4 and rank 6 fill the two category slots
    const r = buildTaskSet({ candidates: doc([A]), decisions: [...reject(g, [2]), ...accept(g, [1, 3, 4, 5, 6])], mode: "human", allowIncomplete: false });
    expect(r.doc.tasks.filter((t) => t.kind === "category").map((t) => t.validation.candidate_rank)).toEqual([4, 6]);
    expect(r.doc.review).toMatchObject({ n_candidates: 6, n_accepted: 5, n_rejected: 1, human_reviewed: true });
    expect(r.doc.review.rejection_rate).toBeCloseTo(1 / 6, 12);
    assertValid("qa-task-set", withProv(r.doc));
  });

  it("an automatically rejected candidate counts as a rejection and is replaced without the human seeing it", () => {
    const B = page("docs-b.example", "docs", [1]); // main rank 1 failed the validators
    const r = buildTaskSet({ candidates: doc([B]), decisions: accept(B.group_id, [2, 3, 4, 5, 6, 7]), mode: "human", allowIncomplete: false });
    expect(r.doc.tasks.filter((t) => t.kind === "main").map((t) => t.validation.candidate_rank)).toEqual([3]); // only one main left: rank 1 is gone, no reserve of the kind
    expect(r.outcomes[0]!.missing).toEqual([{ kind: "main", slots: 1, why: "short" }]);
    expect(r.doc.review.n_rejected).toBe(1);
  });

  it("when the kind has no candidate left the page is short, not padded with another kind", () => {
    const C = page("forum-c.example", "forum", [5, 7]); // both support candidates fail
    const r = buildTaskSet({ candidates: doc([C]), decisions: accept(C.group_id, [1, 2, 3, 4, 6]), mode: "human", allowIncomplete: false });
    expect(r.doc.tasks.map((t) => t.kind).sort()).toEqual(["category", "category", "main", "main"]);
    expect(r.outcomes[0]!.missing).toEqual([{ kind: "support", slots: 1, why: "short" }]);
  });

  it("undecided candidates stop the page: the stage fails unless told to build anyway", () => {
    const decisions = accept(g, [1, 2, 3]); // rank 4 (category) and 5 (support) were never looked at
    expect(() => buildTaskSet({ candidates: doc([A]), decisions, mode: "human", allowIncomplete: false })).toThrow(/incomplete on 1 page/);
    const r = buildTaskSet({ candidates: doc([A]), decisions, mode: "human", allowIncomplete: true });
    expect(r.incomplete_pages).toEqual([g]);
    expect(r.doc.tasks).toHaveLength(3);
    expect(r.outcomes[0]!.missing.map((m) => m.why)).toEqual(["incomplete", "incomplete"]);
  });

  it("pages that are not ok or have no accepted candidate are dropped and listed; an empty set is an error", () => {
    const failed = page("bad.example", "docs", [], "failed");
    const r = buildTaskSet({ candidates: doc([A, failed]), decisions: accept(g, [1, 2, 3, 4, 5]), mode: "human", allowIncomplete: false });
    expect(r.dropped_pages).toEqual([{ group_id: failed.group_id, stratum: "docs", why: "failed" }]);
    expect(() => buildTaskSet({ candidates: doc([failed]), decisions: [], mode: "human", allowIncomplete: false })).toThrow(/empty/);
  });

  it("auto mode (no human) accepts what passed the validators and says so", () => {
    const r = buildTaskSet({ candidates: doc([A]), decisions: [], mode: "auto", allowIncomplete: false });
    expect(r.doc.tasks).toHaveLength(5);
    expect(r.doc.tasks.every((t) => t.validation.by === "auto")).toBe(true);
    expect(r.doc.review.human_reviewed).toBe(false);
    assertValid("qa-task-set", withProv(r.doc));
  });

  it("the task set id is content-addressed: the same review gives the same id, another review another", () => {
    const x = buildTaskSet({ candidates: doc([A]), decisions: accept(g, [1, 2, 3, 4, 5]), mode: "human", allowIncomplete: false });
    const y = buildTaskSet({ candidates: doc([A]), decisions: accept(g, [1, 2, 3, 4, 5]), mode: "human", allowIncomplete: false });
    const z = buildTaskSet({ candidates: doc([A]), decisions: [...reject(g, [1]), ...accept(g, [2, 3, 4, 5])], mode: "human", allowIncomplete: false });
    expect(x.doc.task_set_id).toBe(y.doc.task_set_id);
    expect(z.doc.task_set_id).not.toBe(x.doc.task_set_id);
  });
});

describe("the review export", () => {
  const A = page("docs-a.example", "docs");
  const base = (over: Record<string, unknown> = {}): unknown => ({ format: REVIEW_FORMAT, format_version: "1.0.0", candidates_id: ID, reviewer: "ana", decisions: accept(A.group_id, [1]), ...over });

  it("is parsed, with the reviewer", () => {
    const r = parseReviewExport(base(), doc([A]));
    expect(r.reviewer).toBe("ana");
    expect(r.decisions).toHaveLength(1);
  });

  it("a review of other candidates, an unknown candidate, a repeat and a wrong format are refused", () => {
    expect(() => parseReviewExport(base({ candidates_id: HASH("f") as Sha256 }), doc([A]))).toThrow(/not on/);
    expect(() => parseReviewExport(base({ decisions: accept("nope#1", [1]) }), doc([A]))).toThrow(/not a candidate/);
    expect(() => parseReviewExport(base({ decisions: [...accept(A.group_id, [1]), ...accept(A.group_id, [1])] }), doc([A]))).toThrow(/twice/);
    expect(() => parseReviewExport(base({ format: "x" }), doc([A]))).toThrow(/not a gran-prix.qa-review/);
    expect(() => parseReviewExport(base({ decisions: [{ group_id: A.group_id, rank: 1, answers_from_page: "yes" }] }), doc([A]))).toThrow(/true, false or null/);
  });
});
