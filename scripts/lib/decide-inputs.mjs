// Input access for scripts/decide-dom-v0.mjs: every missing or malformed input becomes a PROBLEM, and the decision
// refuses to run while there is one (a verdict computed over a guess is worse than no verdict).

export class DecisionInputError extends Error {
  constructor(problems) {
    super(`cannot decide: ${problems.length} input problem(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "DecisionInputError";
    this.problems = problems;
  }
}

export const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** `get(o, "a.b.c")`; `undefined` when any step is missing. */
export function get(o, path) {
  let cur = o;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Config values the rules need. Missing ones are listed all at once. */
export const REQUIRED_CONFIG = [
  "seeds", "seed_aggregation.point", "seed_aggregation.ci_lower", "strata.hard", "strata.article",
  "systems.mlp_oof_prefix", "systems.gbdt", "systems.router", "systems.individual", "systems.g6_competitors",
  "qa.respondents", "qa.eligibility_respondent", "qa.arms.full", "qa.arms.model", "qa.arms.router", "qa.arms.oracle", "qa.stratum_separator", "qa.pp_per_unit",
  "bootstrap.resamples", "bootstrap.seed",
  "thresholds.G0.min_delta", "thresholds.G1a.min_delta", "thresholds.G1a.ci_lower_gt", "thresholds.G1b.min_delta",
  "thresholds.G2.test_min_delta", "thresholds.G2.pooled_lower_min", "thresholds.G2.pooled_one_sided_level",
  "thresholds.G3.ci_lower_min_pp", "thresholds.G3.retention_min", "thresholds.G3.category_flag_pp",
  "thresholds.G4.d1_min", "thresholds.G4.d2_min", "thresholds.G4.d2_ml_not_the_source_below",
  "thresholds.G5.p95_ms_max", "thresholds.G5.model_bytes_max", "thresholds.G5.min_pages", "thresholds.G5.cpu_throttle_min", "thresholds.G5.repetitions_min",
  "thresholds.G6.min_delta_vs_competitor", "thresholds.G6.min_pages", "thresholds.G6.inaccessible_share_min", "thresholds.G6.inaccessible_gate_id",
  "thresholds.eligibility.delta_min", "thresholds.eligibility.ci_level", "thresholds.eligibility.ci_lower_gt", "thresholds.eligibility.qa_delta_min_pp", "thresholds.eligibility.retention_min", "thresholds.eligibility.d2_median_min",
  "thresholds.concept_no_go.oracle_delta_pp", "thresholds.concept_no_go.statistic",
  "thresholds.inconclusive_zone.delta_min", "thresholds.inconclusive_zone.ci_lower_max",
  "thresholds.rescue_arm.recall_target", "thresholds.gbdt_minus_mlp_investigate_above",
];

export function checkConfig(config, problems) {
  for (const path of REQUIRED_CONFIG) if (get(config, path) === undefined) problems.push(`config: "${path}" is missing`);
  if (get(config, "seed_aggregation.point") !== undefined && config.seed_aggregation.point !== "mean") problems.push('config: seed_aggregation.point supports only "mean"');
  if (get(config, "seed_aggregation.ci_lower") !== undefined && config.seed_aggregation.ci_lower !== "mean_of_lowers") problems.push('config: seed_aggregation.ci_lower supports only "mean_of_lowers"');
  if (get(config, "thresholds.concept_no_go.statistic") !== undefined && !["point", "ci_lower"].includes(config.thresholds.concept_no_go.statistic)) problems.push('config: concept_no_go.statistic is "point" or "ci_lower"');
}

/** The pages of an intrinsic EvalReport: `{ id, key, stratum, f1 (the model), by: { baseline id -> per-page F1 } }`. */
export function pagesOf(report, label, problems) {
  const pg = get(report, "intrinsic.per_group");
  if (get(report, "format") !== "gran-prix.eval-report" || !Array.isArray(pg)) {
    problems.push(`${label}: not an EvalReport with intrinsic.per_group (the file must be the "report" output of ts:evaluate.intrinsic)`);
    return [];
  }
  return pg.map((g) => ({ id: g.group_id, key: g.group_key ?? g.group_id, stratum: g.stratum, f1: g.f1, by: g.f1_by_baseline ?? {} }));
}

/** Per-page F1 of a system on a page: `model` is the report's own system, the others are baselines. */
export const valueOf = (page, sys) => (sys === "model" ? page.f1 : page.by[sys]);

/** Mean over pages of the per-page F1 (macro-page). Records a problem and returns NaN when some page has no value. */
export function macro(pages, sys, label, problems) {
  if (pages.length === 0) {
    problems.push(`${label}: no pages to average`);
    return NaN;
  }
  const missing = pages.filter((p) => !isNum(valueOf(p, sys)));
  if (missing.length > 0) {
    problems.push(`${label}: system "${sys}" has no per-page F1 on ${missing.length} of ${pages.length} pages (e.g. ${missing[0].id}); every system must cover every page it is compared on`);
    return NaN;
  }
  return pages.reduce((a, p) => a + valueOf(p, sys), 0) / pages.length;
}

/** Per-page differences `a - b` (systems as in `valueOf`), or a problem. */
export function diffs(pages, a, b, label, problems) {
  const out = [];
  for (const p of pages) {
    const x = valueOf(p, a);
    const y = valueOf(p, b);
    if (!isNum(x) || !isNum(y)) {
      problems.push(`${label}: page ${p.id} lacks the per-page F1 of "${isNum(x) ? b : a}"`);
      return [];
    }
    out.push(x - y);
  }
  return out;
}

/** The comparison[] entry of a report: stratum (or aggregate), baseline, metric f1, macro_page. */
export function comparisonOf(report, stratum, baseline) {
  const list = get(report, "intrinsic.comparison");
  if (!Array.isArray(list)) return undefined;
  return list.find((c) => c.stratum === stratum && c.baseline === baseline && c.metric === "f1" && (c.aggregation === undefined || c.aggregation === "macro_page"));
}
