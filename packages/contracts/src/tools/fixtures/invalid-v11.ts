/**
 * Invalid fixtures of the v1.1 additions: every new field and every new contract has a document with ONE
 * deliberate defect (same conventions as `invalid.ts`: ids are re-sealed unless the defect is a stale id).
 */
import { contractId } from "../../identity/contract-ids.js";
import type { IssueCode } from "../../validate/result.js";
import type { ContractName } from "../../registry.js";
import type { Universe } from "./universe.js";
import type { InvalidCase } from "./invalid.js";

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const clone = <T>(v: T): T => structuredClone(v);

export function buildInvalidCasesV11(u: Universe): InvalidCase[] {
  const cases: InvalidCase[] = [];
  const add = (contract: ContractName, name: string, doc: unknown, code: IssueCode, path: string, message?: string): void => {
    cases.push({ file: `${contract}.${name}.json`, contract, doc, expect: { code, path, ...(message ? { message } : {}) } });
  };
  const reid = (contract: Parameters<typeof contractId>[0], idField: string, d: Doc): Doc => ({ ...d, [idField]: contractId(contract, d) });

  // --- page-snapshot v1.1
  {
    const snap = (mutate: (d: Doc) => void): Doc => {
      const d: Doc = clone(u.snapshot);
      mutate(d);
      return reid("page-snapshot", "snapshot_id", d);
    };
    add("page-snapshot", "text-unit-wrong-owner", snap((d) => (d["text_units"][1].id = "n9#t0")), "invariant", "text_units[1].id", "does not name its owner");
    add("page-snapshot", "text-unit-duplicate", snap((d) => (d["text_units"][1] = { ...d["text_units"][0] })), "invariant", "text_units[1].id");
    add("page-snapshot", "text-unit-bad-id", snap((d) => (d["text_units"][0].id = "n2-t0")), "schema", "text_units[0].id", "pattern");
    add("page-snapshot", "text-unit-blank", snap((d) => (d["text_units"][2].t = "  \n ")), "invariant", "text_units[2].t", "NON-BLANK");
    add("page-snapshot", "text-unit-owner-out-of-range", snap((d) => (d["text_units"][3].owner = 99)), "invariant", "text_units[3].owner");
    add("page-snapshot", "text-unit-child-order", snap((d) => (d["text_units"].splice(1, 0, { id: "n3#t4", owner: 3, t: "x" }, { id: "n3#t2", owner: 3, t: "y" }))), "invariant", "text_units[2].id", "document order");
    add("page-snapshot", "own-text-over-cap", snap((d) => (d["probe"].own_text_cap = 5)), "invariant", "nodes[2].own_text", "own_text_cap");
    add("page-snapshot", "unknown-id-scheme", snap((d) => (d["probe"].id_scheme = "gp-composed-preorder/2")), "schema", "probe.id_scheme");
    add("page-snapshot", "settle-unknown-reason", snap((d) => (d["capture"].settle.reason = "timeout")), "schema", "capture.settle.reason");
    add("page-snapshot", "unknown-network-outcome", snap((d) => (d["capture"].network = "yes")), "schema", "capture.network");
    add("page-snapshot", "disclosure-not-boolean", snap((d) => (d["nodes"][7].flags.disclosure = "yes")), "schema", "nodes[7].flags.disclosure");
    add("page-snapshot", "jsonld-types-not-strings", snap((d) => (d["page"].jsonld_types = [1])), "schema", "page.jsonld_types[0]");
  }
  // --- feature-schema v1.1
  {
    const fs = (mutate: (d: Doc) => void): Doc => {
      const d: Doc = clone(u.schema);
      mutate(d);
      return reid("feature-schema", "schema_id", d);
    };
    add("feature-schema", "context-unknown-source", fs((d) => (d["features"][3].context.source = "no_such_feature")), "invariant", "features[3].context.source", "not a feature");
    add("feature-schema", "context-own-source", fs((d) => (d["features"][3].context.source = "parent_link_density")), "invariant", "features[3].context.source", "own source");
    add("feature-schema", "context-source-is-context", fs((d) => (d["features"][1].context = { rel: "next", source: "parent_link_density" })), "invariant", "features[1].context.source", "context feature");
    add("feature-schema", "context-bad-rel", fs((d) => (d["features"][3].context.rel = "child")), "schema", "features[3].context.rel");
    add("feature-schema", "log1p-scale-zero", fs((d) => (d["features"][0].transform.scale = 0)), "schema", "features[0].transform.scale");
  }
  // --- dataset v1.1
  {
    const m = u.dataset.manifest;
    const ds = (mutate: (d: Doc) => void): Doc => {
      const d: Doc = clone(m);
      mutate(d);
      return reid("dataset-manifest", "dataset_id", d);
    };
    add("dataset-manifest", "tags-unsorted", ds((d) => (d["groups"][1].tags = ["logged_in", "lang:pt"])), "invariant", "groups[1].tags[1]", "sorted");
    add("dataset-manifest", "tag-bad-pattern", ds((d) => (d["groups"][0].tags = ["Logged In"])), "schema", "groups[0].tags[0]", "pattern");
    add("dataset-manifest", "by-tag-count-mismatch", ds((d) => (d["stats"].by_tag["lang:en"].groups += 1)), "invariant", "stats.by_tag.lang:en.groups");
    add("dataset-manifest", "by-tag-unknown-tag", ds((d) => (d["stats"].by_tag["logged_out"] = { groups: 1, rows: 1, pos_rate: 0 })), "invariant", "stats.by_tag.logged_out", "no group carries");
    add("dataset-manifest", "unknown-row-weight", ds((d) => (d["row_weight"] = "tokens")), "schema", "row_weight");
    const row: Doc = clone(u.datasetRow);
    row["w"] = -3;
    add("dataset-row", "negative-weight", row, "schema", "w");
  }
  // --- eval-report v1.1
  {
    const ev = (mutate: (d: Doc) => void, base: object = u.evalReport): Doc => {
      const d: Doc = clone(base) as Doc;
      mutate(d);
      return reid("eval-report", "report_id", d);
    };
    add("eval-report", "gate-passed-contradicts-value", ev((d) => (d["gates"][2].passed = false)), "invariant", "gates[2].passed", "<=");
    add("eval-report", "gate-ci-bound-is-not-value", ev((d) => (d["gates"][0].value = d["gates"][0].observed)), "invariant", "gates[0].value", "CI bound");
    add("eval-report", "gate-ci-lower-without-ci", ev((d) => delete d["gates"][0].ci95), "invariant", "gates[0].ci95", "requires ci95");
    add("eval-report", "gate-comparator-without-threshold", ev((d) => delete d["gates"][1].threshold), "invariant", "gates[1].threshold", "together");
    add("eval-report", "gate-unknown-comparator", ev((d) => (d["gates"][1].comparator = "=>")), "schema", "gates[1].comparator");
    add("eval-report", "gate-value-is-not-observed", ev((d) => (d["gates"][1].observed = 3)), "invariant", "gates[1].value", "observed");
    add("eval-report", "comparison-unknown-metric", ev((d) => (d["intrinsic"].comparison[1].metric = "bleu")), "schema", "intrinsic.comparison[1].metric");
    add("eval-report", "comparison-unknown-aggregate", ev((d) => (d["intrinsic"].comparison[2].stratum = "very_hard")), "invariant", "intrinsic.comparison[2].stratum", "aggregates");
    add("eval-report", "pr-curve-unsorted", ev((d) => d["intrinsic"].pr_curve.points.reverse()), "invariant", "intrinsic.pr_curve.points[1].threshold", "ascending");
    add("eval-report", "pr-operating-threshold-differs", ev((d) => (d["intrinsic"].pr_curve.operating_threshold = 0.6)), "invariant", "intrinsic.pr_curve.operating_threshold");
    add("eval-report", "metric-ci-inverted", ev((d) => (d["intrinsic"].metric_ci.model.overall.f1 = [0.9, 0.1])), "invariant", "intrinsic.metric_ci.model.overall.f1");
    add("eval-report", "metric-ci-unknown-stratum", ev((d) => (d["intrinsic"].metric_ci.model.forum = { f1: [0.1, 0.2] })), "invariant", "intrinsic.metric_ci.model.forum");
    add("eval-report", "token-iqr-inverted", ev((d) => (d["intrinsic"].token_reduction.d2.iqr_ratio = [0.5, 0.3])), "invariant", "intrinsic.token_reduction.d2.iqr_ratio");
    add("eval-report", "aggregate-unknown-stratum", ev((d) => (d["intrinsic"].aggregates[0].strata = ["forum"])), "invariant", "intrinsic.aggregates[0].strata[0]");
    add("eval-report", "by-tag-counts-dont-add-up", ev((d) => (d["intrinsic"].by_tag["lang:en"].n += 1)), "invariant", "intrinsic.by_tag.lang:en", "tp+fp+tn+fn");
    add("eval-report", "bootstrap-unknown-cluster", ev((d) => (d["intrinsic"].bootstrap.cluster_by = "domain")), "schema", "intrinsic.bootstrap.cluster_by");
    add("eval-report", "bootstrap-without-resamples", ev((d) => delete d["intrinsic"].bootstrap.resamples), "schema", "intrinsic.bootstrap.resamples", "required");
    add("eval-report", "system-unknown-kind", ev((d) => (d["system"].kind = "mlp")), "schema", "system.kind");
    add("eval-report", "unknown-weighting", ev((d) => (d["intrinsic"].weighting.unit = "pixels")), "schema", "intrinsic.weighting.unit");
    add("eval-report", "runtime-without-p95", ev((d) => delete d["intrinsic"].runtime.p95_ms), "schema", "intrinsic.runtime.p95_ms", "required");
    add("eval-report", "aggregate-micro-counts", ev((d) => (d["intrinsic"].aggregates[0].micro.n += 1)), "invariant", "intrinsic.aggregates[0].micro", "tp+fp+tn+fn");
    add("eval-report", "comparison-unknown-aggregation", ev((d) => (d["intrinsic"].comparison[0].aggregation = "median")), "schema", "intrinsic.comparison[0].aggregation");
    add("eval-report", "baseline-coverage-over-one", ev((d) => (d["intrinsic"].baselines.readability.coverage = 1.2)), "schema", "intrinsic.baselines.readability.coverage");
    add("eval-report", "note-unknown-kind", ev((d) => (d["notes"][0].kind = "warning")), "schema", "notes[0].kind");
    add("eval-report", "evidence-retention-over-one", ev((d) => (d["downstream"].arms.pruned_model.evidence_retention.mean = 1.2), u.downstreamReport), "schema", "downstream.arms.pruned_model.evidence_retention.mean");
    add("eval-report", "evidence-retention-ci-inverted", ev((d) => (d["downstream"].arms.pruned_model.evidence_retention.ci95 = [1, 0.8]), u.downstreamReport), "invariant", "downstream.arms.pruned_model.evidence_retention.ci95");
  }
  // --- stage kind
  {
    const d: Doc = clone(u.demoPipeline);
    d["stages"][0].kind = "demos";
    add("pipeline-spec", "misspelled-demo-kind", d, "schema", "stages[0].kind");
  }
  // --- label-agreement (C0)
  {
    const la = (mutate: (d: Doc) => void): Doc => {
      const d: Doc = clone(u.labelAgreement);
      mutate(d);
      return reid("label-agreement", "agreement_id", d);
    };
    add("label-agreement", "kappa-not-recomputable", la((d) => (d["pairs"][0].results[0].kappa = 0.95)), "invariant", "pairs[0].results[0].kappa", "recomputed");
    add("label-agreement", "observed-agreement-wrong", la((d) => (d["pairs"][0].results[0].observed_agreement = 0.5)), "invariant", "pairs[0].results[0].observed_agreement");
    add("label-agreement", "n-differs-from-confusion", la((d) => (d["pairs"][0].results[0].n = 101)), "invariant", "pairs[0].results[0].n");
    add("label-agreement", "confusion-not-square", la((d) => d["pairs"][0].results[0].confusion[1].pop()), "invariant", "pairs[0].results[0].confusion", "x 2");
    add("label-agreement", "binary-with-three-classes", la((d) => (d["pairs"][0].results[0].classes = ["a", "b", "c"])), "invariant", "pairs[0].results[0].classes", "exactly 2");
    add("label-agreement", "self-pair", la((d) => (d["pairs"][0].b = "human")), "invariant", "pairs[0].b", "itself");
    add("label-agreement", "unknown-labeler", la((d) => (d["pairs"][0].b = "gpt")), "invariant", "pairs[0].b", "labelers");
    add("label-agreement", "unknown-stratum", la((d) => (d["pairs"][1].stratum = "forum")), "invariant", "pairs[1].stratum");
    add("label-agreement", "duplicate-pair", la((d) => d["pairs"].push(structuredClone(d["pairs"][0]))), "invariant", "pairs[3]", "duplicate pair");
    add("label-agreement", "population-units-dont-sum", la((d) => (d["population"].n_units = 99)), "invariant", "population.n_units");
    add("label-agreement", "gate-contradicts-kappa", la((d) => (d["gates"][0].passed = false)), "invariant", "gates[0].passed");
    add("label-agreement", "ci-inverted", la((d) => (d["pairs"][0].results[0].ci95 = [0.9, 0.5])), "invariant", "pairs[0].results[0].ci95");
    add("label-agreement", "kappa-over-one", la((d) => (d["pairs"][0].results[0].kappa = 1.2)), "schema", "pairs[0].results[0].kappa");
    add("label-agreement", "single-labeler", la((d) => (d["labelers"] = { human: { kind: "human" } })), "schema", "labelers");
    add("label-agreement", "stale-id", (() => { const d: Doc = clone(u.labelAgreement); d["guide_version"] = "9.9.9"; return d; })(), "id-mismatch", "agreement_id");
  }
  // --- qa-task-set (C10)
  {
    const qa = (mutate: (d: Doc) => void): Doc => {
      const d: Doc = clone(u.qaTaskSet);
      mutate(d);
      return reid("qa-task-set", "task_set_id", d);
    };
    add("qa-task-set", "evidence-in-noise", qa((d) => (d["tasks"][0].evidence.class = "noise")), "schema", "tasks[0].evidence.class");
    add("qa-task-set", "answer-over-20-words", qa((d) => (d["tasks"][0].answer = Array.from({ length: 21 }, (_, i) => `w${i}`).join(" "))), "invariant", "tasks[0].answer", "20");
    add("qa-task-set", "unknown-page", qa((d) => (d["tasks"][0].group_id = "g99")), "invariant", "tasks[0].group_id");
    add("qa-task-set", "stratum-differs-from-page", qa((d) => (d["tasks"][0].stratum = "docs")), "invariant", "tasks[0].stratum");
    add("qa-task-set", "duplicate-task-id", qa((d) => (d["tasks"][1].id = d["tasks"][0].id)), "invariant", "tasks[1].id", "duplicate");
    add("qa-task-set", "evidence-units-not-increasing", qa((d) => (d["tasks"][1].evidence.unit_ids = [4, 3])), "invariant", "tasks[1].evidence.unit_ids[1]");
    add("qa-task-set", "evidence-without-units", qa((d) => (d["tasks"][0].evidence.unit_ids = [])), "schema", "tasks[0].evidence.unit_ids");
    add("qa-task-set", "review-counts", qa((d) => (d["review"].n_rejected = 5)), "invariant", "review.n_candidates");
    add("qa-task-set", "rejection-rate-wrong", qa((d) => (d["review"].rejection_rate = 0.5)), "invariant", "review.rejection_rate");
    add("qa-task-set", "accepted-count-differs-from-tasks", qa((d) => (d["review"].n_accepted = 3)), "invariant", "review.n_accepted");
    add("qa-task-set", "unknown-task-kind", qa((d) => (d["tasks"][0].kind = "trivia")), "schema", "tasks[0].kind");
    add("qa-task-set", "empty-tasks", qa((d) => (d["tasks"] = [])), "schema", "tasks");
    add("qa-task-set", "stale-id", (() => { const d: Doc = clone(u.qaTaskSet); d["generator"].model = "other"; return d; })(), "id-mismatch", "task_set_id");
  }
  return cases;
}
