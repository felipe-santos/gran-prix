import { assertValid, canonicalJson, type Sha256 } from "@gran-prix/contracts";
import { defineStage, type StagePlugin } from "../../stage.js";
import type { ArtifactHandle } from "../../store.js";
import { optionalSingle, provenance, single } from "./stage-common.js";
import { buildTaskSet, parseReviewExport } from "./taskset.js";
import { CANDIDATES_FORMAT, REVIEW_FORMAT, TASKSET_SUMMARY_FORMAT, type CandidatesDoc } from "./types.js";

/**
 * `ts:qa.taskset@1.0.0` (E3.4, protocol 9, step 3): the import of the human review. Candidates + the JSON the review
 * page exported -> the final `qa-task-set` (quotas of 2 main, 2 category, 1 support per page; a rejected candidate is
 * replaced by the next of its kind, in order; the rejection rate is recorded). `mode: "auto"` skips the human (a
 * rehearsal): every candidate that passed the validators is accepted and `human_reviewed` is false. `determinism:
 * "pure"`: no call, nothing paid.
 */

export const TASKSET_IMPL = "ts:qa.taskset@1.0.0";
const dec = new TextDecoder();

function jsonOf(h: ArtifactHandle, format: string): unknown {
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
  throw new Error(`artifact ${h.id} holds no ${format} document (files: ${h.files().join(", ") || "none"})`);
}

export const tasksetStage: StagePlugin = defineStage(
  {
    kind: "evaluate",
    impl: TASKSET_IMPL,
    inputs: [
      { name: "candidates", type: "Bundle" },
      { name: "review", type: "Bundle", optional: true },
    ],
    outputs: [
      { name: "taskset", type: "QaTaskSet" },
      { name: "summary", type: "Bundle" },
    ],
    params_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { enum: ["human", "auto"], description: 'human (default): only what a person accepted. auto: no review, every candidate that passed the automatic validators is accepted (a rehearsal; the task set says human_reviewed false).' },
        allow_incomplete: { type: "boolean", description: "Build the set even when the review left candidates undecided on some page (default false: the stage fails)." },
        dataset_id: { type: "string", pattern: "^sha256:[0-9a-f]{64}$", description: "Overrides the dataset id of the candidates document." },
      },
    },
    runtime: "node",
    determinism: "pure",
  },
  (ctx) => {
    const p = ctx.params as { mode?: "human" | "auto"; allow_incomplete?: boolean; dataset_id?: Sha256 };
    const mode = p.mode ?? "human";
    const cdoc = jsonOf(single(ctx, "candidates"), CANDIDATES_FORMAT) as CandidatesDoc;
    const reviewHandle = optionalSingle(ctx, "review");
    if (mode === "human" && reviewHandle === undefined) throw new Error('mode "human" needs the review export (input "review"): grade the candidates in review.html and export the JSON');
    const review = reviewHandle === undefined || mode === "auto" ? undefined : parseReviewExport(jsonOf(reviewHandle, REVIEW_FORMAT), cdoc);
    const built = buildTaskSet({ candidates: cdoc, decisions: review?.decisions ?? [], mode, allowIncomplete: p.allow_incomplete === true, ...(p.dataset_id !== undefined ? { datasetId: p.dataset_id } : {}) });
    const taskset = assertValid("qa-task-set", { ...built.doc, provenance: provenance(ctx) });
    const count = (f: (t: (typeof taskset.tasks)[number]) => string): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const t of taskset.tasks) out[f(t)] = (out[f(t)] ?? 0) + 1;
      return Object.fromEntries(Object.entries(out).sort());
    };
    const summary = {
      format: TASKSET_SUMMARY_FORMAT,
      format_version: "1.0.0",
      task_set_id: taskset.task_set_id,
      candidates_id: cdoc.candidates_id,
      mode,
      reviewer: review?.reviewer ?? null,
      tasks: { total: taskset.tasks.length, by_kind: count((t) => t.kind), by_stratum: count((t) => t.stratum), by_validation: count((t) => t.validation.by) },
      review: taskset.review,
      pages: { used: taskset.pages.length, dropped: built.dropped_pages, incomplete: built.incomplete_pages },
      short: built.outcomes.filter((o) => o.missing.length > 0).map((o) => ({ group_id: o.group_id, missing: o.missing })),
      automatic_rejection: cdoc.validation.rejection,
    };
    ctx.log(
      `${taskset.tasks.length} task(s) on ${taskset.pages.length} page(s); rejection ${(taskset.review.rejection_rate * 100).toFixed(1)}% of ${taskset.review.n_candidates} candidate(s) looked at${built.incomplete_pages.length > 0 ? `; ${built.incomplete_pages.length} page(s) incomplete` : ""}${mode === "auto" ? "; NO human review (auto)" : ""}`,
    );
    return { taskset: { json: taskset }, summary: { files: { "summary.json": `${canonicalJson(summary)}\n` } } };
  },
);
