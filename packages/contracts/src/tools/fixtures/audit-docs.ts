/** Synthetic fixture documents for LabelAgreement (C0) and QaTaskSet (C10). No real page text. */
import { contractId } from "../../identity/contract-ids.js";
import type { Sha256 } from "../../identity/hash.js";
import type { KappaResult, LabelAgreement } from "../../label-agreement.js";
import type { QaTaskSet } from "../../qa-task-set.js";
import { buildProvenance } from "./model-docs.js";
import { sha } from "./extract-docs.js";

/** Cohen's kappa block computed from a confusion matrix (the validator recomputes the same numbers). */
export function kappaResult(
  space: KappaResult["space"],
  weighting: KappaResult["weighting"],
  classes: string[],
  confusion: number[][],
  nGroups: number,
  ci95?: [number, number],
): KappaResult {
  const n = confusion.reduce((s, r) => s + r.reduce((a, b) => a + b, 0), 0);
  const rows = confusion.map((r) => r.reduce((a, b) => a + b, 0));
  const cols = classes.map((_, c) => confusion.reduce((s, r) => s + (r[c] as number), 0));
  const po = confusion.reduce((s, r, i) => s + (r[i] as number), 0) / n;
  const pe = rows.reduce((s, r, i) => s + r * (cols[i] as number), 0) / (n * n);
  return {
    space, weighting, classes, confusion, n, observed_agreement: po, expected_agreement: pe,
    kappa: (po - pe) / (1 - pe), ...(ci95 ? { ci95 } : {}), n_groups: nGroups,
  };
}

const BIN = ["drop", "keep"];
const THREE = ["main", "support", "noise"];

export function buildLabelAgreement(datasetId: Sha256): LabelAgreement {
  const humanLlm = kappaResult("binary", "elements", BIN, [[42, 4], [4, 50]], 5, [0.71, 0.93]);
  const humanLlmDocs = kappaResult("binary", "elements", BIN, [[16, 2], [2, 20]], 2, [0.6, 0.95]);
  const doc: LabelAgreement = {
    format: "gran-prix.label-agreement",
    format_version: "1.0.0",
    agreement_id: sha("placeholder"),
    dataset_id: datasetId,
    guide_version: "1.0.0",
    population: {
      unit: "dom-element-with-own-text",
      n_groups: 5,
      n_units: 100,
      n_chars: 12000,
      by_stratum: { article: { n_groups: 3, n_units: 60 }, docs: { n_groups: 2, n_units: 40 } },
    },
    labelers: {
      human: { kind: "human" },
      llm: { kind: "llm", version: "1.0.0", labels_ids: [sha("labels-llm")] },
      readability: { kind: "readability", version: "0.6.0" },
    },
    pairs: [
      {
        a: "human", b: "llm", stratum: "overall",
        results: [
          humanLlm,
          kappaResult("three_class", "elements", THREE, [[30, 3, 1], [4, 12, 2], [1, 3, 44]], 5, [0.6, 0.9]),
          kappaResult("binary", "chars", BIN, [[900, 120], [80, 1300]], 5, [0.7, 0.95]),
        ],
      },
      { a: "human", b: "llm", stratum: "docs", results: [humanLlmDocs] },
      { a: "human", b: "readability", stratum: "overall", results: [kappaResult("binary", "elements", BIN, [[34, 12], [10, 44]], 5)] },
    ],
    bootstrap: { resamples: 10000, seed: 20261125, cluster_by: "group_key", method: "percentile", stratified: true },
    retest: { labeler: "human", n_groups: 2, n_units: 40, interval_days: 8, kappa_binary: 0.88, ci95: [0.7, 0.97] },
    gates: [
      {
        id: "d7_kappa_binary_pooled", name: "D7 pooled binary kappa (LLM vs human)", rule: "kappa_binary >= 0.80 pooled",
        value: humanLlm.kappa, passed: humanLlm.kappa >= 0.8, comparator: ">=", threshold: 0.8, unit: "kappa", stratum: "overall", observed: humanLlm.kappa,
      },
      {
        id: "d7_kappa_binary_docs", name: "D7 binary kappa on a hard category", rule: "kappa_binary >= 0.70 per hard category",
        value: humanLlmDocs.kappa, passed: humanLlmDocs.kappa >= 0.7, comparator: ">=", threshold: 0.7, unit: "kappa", stratum: "docs", observed: humanLlmDocs.kappa,
      },
    ],
    notes: [{ kind: "note", text: "Synthetic audit: the numbers only exercise the contract." }],
    provenance: buildProvenance("audit", "evaluate", "ts:evaluate.label-agreement@1.0.0"),
  };
  return { ...doc, agreement_id: contractId("label-agreement", doc) };
}

export function buildQaTaskSet(snapshotId: Sha256, datasetId: Sha256): QaTaskSet {
  const accepted = { status: "accepted" as const, by: "human" as const };
  const doc: QaTaskSet = {
    format: "gran-prix.qa-task-set",
    format_version: "1.0.0",
    task_set_id: sha("placeholder"),
    dataset_id: datasetId,
    generator: { model: "generator-model", prompt_sha256: sha("qa-generator-prompt"), source: "D2 full-page markdown", converter: "turndown@7.2.0+gfm" },
    pages: [
      { group_id: "g00_site0", snapshot_id: snapshotId, stratum: "article", split: "test", prediction: "frozen_model" },
      { group_id: "g01_site1", snapshot_id: sha("snapshot:g01_site1"), stratum: "docs", split: "val", prediction: "oof" },
    ],
    tasks: [
      {
        id: "q001", group_id: "g00_site0", stratum: "article", kind: "main", question: "What is the heading of the page?",
        answer: "Example heading", answer_variants: ["the Example heading"],
        evidence: { unit_ids: [2], quote: "Example heading", class: "main" }, validation: { ...accepted, candidate_rank: 1 },
      },
      {
        id: "q002", group_id: "g00_site0", stratum: "article", kind: "support", question: "Where does the link in the paragraph lead?",
        answer: "/next", answer_variants: ["next page", "/next"],
        evidence: { unit_ids: [3, 4], quote: "Synthetic paragraph text. next", class: "support" }, validation: { ...accepted, candidate_rank: 2 },
      },
      {
        id: "q003", group_id: "g01_site1", stratum: "docs", kind: "category", question: "What does the collapsed FAQ entry say?",
        answer: "Hidden FAQ answer.", answer_variants: ["Hidden FAQ answer"],
        evidence: { unit_ids: [7], quote: "Hidden FAQ answer.", class: "support" }, validation: accepted,
      },
      {
        id: "q004", group_id: "g01_site1", stratum: "docs", kind: "main", question: "Which element is the page about?",
        answer: "an example", answer_variants: [],
        evidence: { unit_ids: [2], quote: "Example heading", class: "main" }, validation: accepted,
      },
    ],
    review: { n_candidates: 6, n_accepted: 4, n_rejected: 2, rejection_rate: 2 / 6, human_reviewed: true },
    provenance: buildProvenance("qa_tasks", "evaluate", "ts:evaluate.qa-task-set@1.0.0"),
  };
  return { ...doc, task_set_id: contractId("qa-task-set", doc) };
}
