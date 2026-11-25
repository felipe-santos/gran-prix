#!/usr/bin/env node
/**
 * The decision rules of the DOM experiment (protocol section 11), computed by script, without judgment.
 *
 *   node scripts/decide-dom-v0.mjs --evidence <evidence.json> [--config pipelines/dom-v0-decision.json] [--out <dir>]
 *
 * `evidence.json` names the EvalReports (paths relative to the file itself):
 *   { "dev_oof": "...", "test": { "1": "...", ... "5": "..." }, "qa": { "r1": "...", "r2": "..." },
 *     "router_tokens": "...", "g5": "...", "g6": "...", "extension_done": false, "rescue_done": false }
 *  - dev_oof: evaluate on split dev, with the OOF bundles (mlp-s1..5, gbdt) and the heuristics as baselines (G0, best baselines);
 *  - test[seed]: evaluate on the test split of each seed's frozen model, with the same baselines (G1a, G1b, G2, G4, eligibility);
 *  - qa.r1 / qa.r2: downstream EvalReports of the two respondents (G3, the oracle arm);
 *  - router_tokens: intrinsic EvalReport of the router with token_reduction (G4 of the router system, rule 4);
 *  - g5: report with intrinsic.runtime; g6: intrinsic report of the logged-in pages.
 * The thresholds come from the config file (pipelines/dom-v0-decision.json); this script has none of its own. The
 * order is fixed (protocol 11): concept NO-GO by the oracle arm, GO, conditional GO, PIVOT, NO-GO. Writes
 * `decision.json` and `decision.md`; exit 0 with a verdict, 2 when an input is missing or malformed (it never guesses).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DecisionInputError, checkConfig, comparisonOf, diffs, get, isNum, macro, pagesOf } from "./lib/decide-inputs.mjs";
import { renderMarkdown } from "./lib/decide-markdown.mjs";
import { clusterBootstrapQuantile, mean } from "./lib/decide-stats.mjs";

export { DecisionInputError, renderMarkdown };

const argmax = (ids, score) => ids.reduce((best, id) => (best === undefined || score(id) > score(best) ? id : best), undefined);
const sepOf = (cfg) => cfg.qa.stratum_separator;

/** Evaluates the rules of section 11. Throws `DecisionInputError` (all problems at once) when an input is missing. */
export function decide(evidence, config, meta = {}) {
  const problems = [];
  checkConfig(config, problems);
  if (problems.length > 0) throw new DecisionInputError(problems);
  const T = config.thresholds;
  const S = config.systems;
  const HARD = config.strata.hard;
  const ART = config.strata.article;
  const seeds = config.seeds.map(String);
  const PP = config.qa.pp_per_unit;
  const boot = (values, keys, q) => clusterBootstrapQuantile(values, keys, { resamples: config.bootstrap.resamples, seed: config.bootstrap.seed, q });
  const need = (cond, msg) => cond || (problems.push(msg), false);

  // ------------------------------------------------------------------------------------------ dev (G0, best baselines)
  need(evidence.dev_oof !== undefined, "evidence: dev_oof (the evaluate report on split dev) is missing");
  const dev = evidence.dev_oof === undefined ? [] : pagesOf(evidence.dev_oof, "dev_oof", problems);
  const devHard = dev.filter((p) => HARD.includes(p.stratum));
  const devArt = dev.filter((p) => p.stratum === ART);
  need(devHard.length > 0 || dev.length === 0, `dev_oof: no page of the hard strata (${HARD.join(", ")})`);
  need(devArt.length > 0 || dev.length === 0, `dev_oof: no page of the article stratum "${ART}"`);
  const pool = [...S.individual, S.router];
  const devScore = (pages, id, what) => macro(pages, id, `dev_oof ${what}`, problems);
  const indivScores = Object.fromEntries(S.individual.map((id) => [id, devScore(devHard, id, "hard")]));
  const gbdtDev = devScore(devHard, S.gbdt, "hard");
  const bestIndividual = argmax(S.individual, (id) => indivScores[id]);
  const bestByStratum = {};
  for (const c of [...HARD, ART]) {
    const pages = dev.filter((p) => p.stratum === c);
    if (pages.length === 0) continue;
    const scores = Object.fromEntries(pool.map((id) => [id, devScore(pages, id, c)]));
    const id = argmax(pool, (x) => scores[x]);
    bestByStratum[c] = { id, f1: scores[id], n_pages: pages.length };
  }
  const bestArticle = bestByStratum[ART]?.id;

  // ------------------------------------------------------------------------------------------ per seed on the test
  const perSeed = {};
  for (const s of seeds) {
    const report = evidence.test?.[s];
    if (!need(report !== undefined, `evidence: test["${s}"] (the evaluate report of seed ${s} on the test split) is missing`)) continue;
    const label = `test[${s}]`;
    const pages = pagesOf(report, label, problems);
    const hard = pages.filter((p) => HARD.includes(p.stratum));
    const art = pages.filter((p) => p.stratum === ART);
    need(hard.length > 0 && art.length > 0, `${label}: needs pages of the hard strata and of "${ART}"`);
    const o = { delta_best_individual: NaN, ci_lower_best_individual: NaN, delta_router: NaN, delta_article: NaN, pooled_lower: NaN, gbdt_minus_mlp: NaN, cats: {} };
    if (bestIndividual !== undefined) {
      o.delta_best_individual = mean(diffs(hard, "model", bestIndividual, `${label} hard vs ${bestIndividual}`, problems));
      const cmp = comparisonOf(report, "hard", bestIndividual);
      if (!need(cmp !== undefined && Array.isArray(cmp.ci95), `${label}: comparison[] has no entry "hard" vs "${bestIndividual}" (evaluate needs params.aggregates with "hard" and the baseline)`)) o.ci_lower_best_individual = NaN;
      else {
        o.ci_lower_best_individual = cmp.ci95[0];
        need(Math.abs(cmp.delta - o.delta_best_individual) < 1e-6, `${label}: comparison "hard" vs "${bestIndividual}" says delta ${cmp.delta}, the per-page F1 give ${o.delta_best_individual} (the report is inconsistent)`);
      }
    }
    o.delta_router = mean(diffs(hard, "model", S.router, `${label} hard vs router`, problems));
    o.gbdt_minus_mlp = macro(hard, S.gbdt, `${label} hard`, problems) - macro(hard, "model", `${label} hard`, problems);
    if (bestArticle !== undefined) {
      const dt = diffs(art, "model", bestArticle, `${label} article vs ${bestArticle}`, problems);
      o.delta_article = mean(dt);
      const dd = diffs(devArt, `${S.mlp_oof_prefix}${s}`, bestArticle, `dev_oof article: ${S.mlp_oof_prefix}${s} vs ${bestArticle}`, problems);
      if (dt.length > 0 && dd.length > 0) o.pooled_lower = boot([...dd, ...dt], [...devArt.map((p) => p.key), ...art.map((p) => p.key)], 1 - T.G2.pooled_one_sided_level);
      o.pooled_n_pages = dd.length + dt.length;
    }
    for (const c of HARD) {
      const cp = hard.filter((p) => p.stratum === c);
      const base = bestByStratum[c]?.id;
      if (cp.length === 0 || base === undefined) continue;
      const d = diffs(cp, "model", base, `${label} ${c} vs ${base}`, problems);
      if (d.length > 0) o.cats[c] = { baseline: base, delta: mean(d), ci_lower: boot(d, cp.map((p) => p.key), (1 - T.eligibility.ci_level) / 2), n_pages: cp.length };
    }
    const tr = get(report, "intrinsic.token_reduction");
    o.d1 = get(tr, "d1.median_reduction");
    o.d2 = get(tr, "d2.median_reduction");
    o.d2_by_stratum = Object.fromEntries(HARD.map((c) => [c, get(tr, `d2.by_stratum.${c}.median_reduction`)]));
    need(isNum(o.d1) && isNum(o.d2), `${label}: intrinsic.token_reduction needs d1.median_reduction and d2.median_reduction (G4)`);
    perSeed[s] = o;
  }
  const vals = (f) => seeds.map((s) => perSeed[s]).filter(Boolean).map(f);
  const agg = (f) => (vals(f).length === seeds.length ? mean(vals(f)) : NaN);
  const aggMin = (f) => (vals(f).length === seeds.length ? Math.min(...vals(f)) : NaN);

  // ------------------------------------------------------------------------------------------ QA (G3, oracle arm)
  const A = config.qa.arms;
  const qa = {};
  for (const r of config.qa.respondents) {
    const report = evidence.qa?.[r];
    if (!need(report !== undefined, `evidence: qa["${r}"] (the downstream EvalReport of respondent ${r}) is missing`)) continue;
    const arms = get(report, "downstream.arms");
    const deltas = get(report, "downstream.paired_deltas");
    if (!need(arms !== undefined && Array.isArray(deltas), `qa[${r}]: not a downstream EvalReport (needs downstream.arms and downstream.paired_deltas)`)) continue;
    const pd = (a, b) => {
      const d = deltas.find((x) => x.a === a && x.b === b);
      return need(d !== undefined && isNum(d.mean_delta) && Array.isArray(d.ci95), `qa[${r}]: paired_deltas has no entry a="${a}", b="${b}"`) ? { point: d.mean_delta * PP, lower: d.ci95[0] * PP } : { point: NaN, lower: NaN };
    };
    const ret = (arm) => get(arms, `${arm}.evidence_retention`);
    const o = { model: pd(A.model, A.full), oracle: pd(A.oracle, A.full), router: pd(A.router, A.full), categories: {} };
    o.retention = get(ret(A.model), "mean");
    o.router_retention = get(ret(A.router), "mean");
    need(isNum(o.retention) && isNum(o.router_retention), `qa[${r}]: arms "${A.model}" and "${A.router}" need evidence_retention.mean (G3)`);
    for (const c of HARD) {
      const d = pd(`${A.model}${sepOf(config)}${c}`, `${A.full}${sepOf(config)}${c}`);
      const n = get(ret(A.model), `by_stratum.${c}.n_questions`);
      const rc = get(ret(A.model), `by_stratum.${c}.mean`);
      need(isNum(n) && isNum(rc), `qa[${r}]: arm "${A.model}" evidence_retention.by_stratum.${c} needs mean and n_questions`);
      o.categories[c] = { delta_pp: d.point, retention: rc, n_questions: n };
    }
    qa[r] = o;
  }

  // ------------------------------------------------------------------------------------------ G4 of the router, G5, G6
  const rt = evidence.router_tokens === undefined ? undefined : get(evidence.router_tokens, "intrinsic.token_reduction");
  need(rt !== undefined, "evidence: router_tokens (an intrinsic EvalReport of the router with token_reduction) is missing");
  const routerD1 = get(rt, "d1.median_reduction");
  const routerD2 = get(rt, "d2.median_reduction");
  need(rt === undefined || (isNum(routerD1) && isNum(routerD2)), "router_tokens: needs d1.median_reduction and d2.median_reduction");
  const rtm = evidence.g5 === undefined ? undefined : get(evidence.g5, "intrinsic.runtime");
  need(rtm !== undefined && isNum(rtm.p95_ms) && isNum(rtm.model_bytes), "evidence: g5 (a report with intrinsic.runtime.p95_ms and model_bytes) is missing or incomplete");
  if (rtm !== undefined) {
    need(rtm.n_pages >= T.G5.min_pages, `g5: ${rtm.n_pages} pages measured, the protocol asks for at least ${T.G5.min_pages}`);
    need(rtm.cpu_throttle >= T.G5.cpu_throttle_min, `g5: cpu_throttle ${rtm.cpu_throttle}, the protocol asks for ${T.G5.cpu_throttle_min}x`);
    need(rtm.repetitions >= T.G5.repetitions_min, `g5: ${rtm.repetitions} repetitions, the protocol asks for ${T.G5.repetitions_min}`);
  }
  const g6cmp = (id) => (evidence.g6 === undefined ? undefined : comparisonOf(evidence.g6, "overall", id));
  need(evidence.g6 !== undefined, "evidence: g6 (the intrinsic report of the logged-in pages) is missing");
  const g6 = { competitors: {}, share: get((get(evidence.g6, "gates") ?? []).find((g) => g.id === T.G6.inaccessible_gate_id), "value") };
  for (const id of S.g6_competitors) {
    const c = g6cmp(id);
    if (!need(evidence.g6 === undefined || (c !== undefined && isNum(c.delta)), `g6: comparison[] has no "overall" entry against "${id}"`)) continue;
    need(c.n_groups >= T.G6.min_pages, `g6: ${c.n_groups} logged-in pages, the protocol asks for at least ${T.G6.min_pages}`);
    g6.competitors[id] = { delta: c.delta, n_pages: c.n_groups };
  }
  need(evidence.g6 === undefined || isNum(g6.share), `g6: gates[] has no entry "${T.G6.inaccessible_gate_id}" with the share of pages that a plain GET cannot reach`);

  if (problems.length > 0) throw new DecisionInputError(problems);

  // ------------------------------------------------------------------------------------------ the gates
  const ok = (v, cmp, t) => (cmp === ">=" ? v >= t : cmp === ">" ? v > t : cmp === "<=" ? v <= t : v < t);
  const G0 = { gbdt: gbdtDev, best_individual: bestIndividual, best_individual_f1: indivScores[bestIndividual], delta: gbdtDev - indivScores[bestIndividual], threshold: T.G0.min_delta, individual: indivScores, n_pages: devHard.length };
  G0.passed = ok(G0.delta, ">=", T.G0.min_delta);
  const G1a = { baseline: bestIndividual, delta: agg((o) => o.delta_best_individual), ci_lower: agg((o) => o.ci_lower_best_individual), ci_lower_min_over_seeds: aggMin((o) => o.ci_lower_best_individual), threshold: T.G1a.min_delta, ci_lower_gt: T.G1a.ci_lower_gt, per_seed: vals((o) => o.delta_best_individual) };
  G1a.passed = ok(G1a.delta, ">=", T.G1a.min_delta) && ok(G1a.ci_lower, ">", T.G1a.ci_lower_gt);
  const G1b = { baseline: S.router, delta: agg((o) => o.delta_router), threshold: T.G1b.min_delta, per_seed: vals((o) => o.delta_router) };
  G1b.passed = ok(G1b.delta, ">=", T.G1b.min_delta);
  const G2 = { baseline: bestArticle, test_delta: agg((o) => o.delta_article), test_threshold: T.G2.test_min_delta, pooled_lower: agg((o) => o.pooled_lower), pooled_threshold: T.G2.pooled_lower_min, pooled_level: T.G2.pooled_one_sided_level, pooled_n_pages: vals((o) => o.pooled_n_pages)[0], pooled_per_seed: vals((o) => o.pooled_lower) };
  G2.passed = ok(G2.test_delta, ">=", T.G2.test_min_delta) && ok(G2.pooled_lower, ">=", T.G2.pooled_lower_min);
  const g3of = (r, key, retKey) => ({ ci_lower_pp: qa[r][key].lower, delta_pp: qa[r][key].point, retention: qa[r][retKey], passed: qa[r][key].lower >= T.G3.ci_lower_min_pp && qa[r][retKey] >= T.G3.retention_min });
  const G3 = { threshold_pp: T.G3.ci_lower_min_pp, retention_min: T.G3.retention_min, respondents: Object.fromEntries(config.qa.respondents.map((r) => [r, g3of(r, "model", "retention")])) };
  G3.passed = config.qa.respondents.every((r) => G3.respondents[r].passed);
  G3.flagged_categories = Object.fromEntries(config.qa.respondents.map((r) => [r, HARD.filter((c) => qa[r].categories[c].delta_pp < T.G3.category_flag_pp)]));
  const G3router = { respondents: Object.fromEntries(config.qa.respondents.map((r) => [r, g3of(r, "router", "router_retention")])) };
  G3router.passed = config.qa.respondents.every((r) => G3router.respondents[r].passed);
  const G4 = { d1: agg((o) => o.d1), d2: agg((o) => o.d2), d1_min: T.G4.d1_min, d2_min: T.G4.d2_min, ml_is_not_the_source: agg((o) => o.d2) < T.G4.d2_ml_not_the_source_below };
  G4.passed = ok(G4.d1, ">=", T.G4.d1_min) && ok(G4.d2, ">=", T.G4.d2_min);
  const G4router = { d1: routerD1, d2: routerD2, passed: routerD1 >= T.G4.d1_min && routerD2 >= T.G4.d2_min };
  const G5 = { p95_ms: rtm.p95_ms, model_bytes: rtm.model_bytes, passed: rtm.p95_ms <= T.G5.p95_ms_max && rtm.model_bytes <= T.G5.model_bytes_max, thresholds: { p95_ms_max: T.G5.p95_ms_max, model_bytes_max: T.G5.model_bytes_max } };
  const G6 = { competitors: g6.competitors, inaccessible_share: g6.share, thresholds: T.G6 };
  G6.passed = S.g6_competitors.every((id) => g6.competitors[id].delta >= T.G6.min_delta_vs_competitor) && g6.share >= T.G6.inaccessible_share_min;

  // ------------------------------------------------------------------------------------------ eligibility per category
  const elig = {};
  const el = T.eligibility;
  const eligR = config.qa.eligibility_respondent;
  for (const c of HARD) {
    const delta = agg((o) => o.cats[c]?.delta);
    const lower = agg((o) => o.cats[c]?.ci_lower);
    const d2 = agg((o) => o.d2_by_stratum[c]);
    const q = qa[eligR].categories[c];
    const checks = {
      delta: { value: delta, threshold: el.delta_min, passed: ok(delta, ">=", el.delta_min) },
      ci_lower: { value: lower, threshold: el.ci_lower_gt, level: el.ci_level, passed: ok(lower, ">", el.ci_lower_gt) },
      qa_delta_pp: { value: q.delta_pp, threshold: el.qa_delta_min_pp, passed: ok(q.delta_pp, ">=", el.qa_delta_min_pp) },
      retention: { value: q.retention, threshold: el.retention_min, passed: ok(q.retention, ">=", el.retention_min) },
      d2_median: { value: d2, threshold: el.d2_median_min, passed: ok(d2, ">=", el.d2_median_min) },
    };
    elig[c] = { baseline: bestByStratum[c]?.id, n_pages: perSeed[seeds[0]].cats[c]?.n_pages, checks, eligible: Object.values(checks).every((x) => x.passed) };
  }
  const eligible = HARD.filter((c) => elig[c].eligible);
  const nq = (r, c) => qa[r].categories[c].n_questions;
  const G3eligible = {
    categories: eligible,
    respondents: Object.fromEntries(
      config.qa.respondents.map((r) => {
        const n = eligible.reduce((a, c) => a + nq(r, c), 0);
        const pooled = n > 0 ? eligible.reduce((a, c) => a + qa[r].categories[c].delta_pp * nq(r, c), 0) / n : NaN;
        return [r, { pooled_delta_pp: pooled, n_questions: n, passed: ok(pooled, ">=", T.G3.ci_lower_min_pp) }];
      }),
    ),
    approximation: "the per-category QA deltas carry no interval, so the aggregate over the eligible categories is the question-weighted POINT delta compared with the G3 bound; the owner should confirm this reading",
  };
  G3eligible.passed = eligible.length > 0 && config.qa.respondents.every((r) => G3eligible.respondents[r].passed);

  // ------------------------------------------------------------------------------------------ section 11, in the fixed order
  const stat = T.concept_no_go.statistic;
  const oracle = Object.fromEntries(config.qa.respondents.map((r) => [r, { delta_pp: qa[r].oracle.point, ci_lower_pp: qa[r].oracle.lower, fires: (stat === "point" ? qa[r].oracle.point : qa[r].oracle.lower) < T.concept_no_go.oracle_delta_pp }]));
  const conceptNoGo = config.qa.respondents.some((r) => oracle[r].fires);
  const g1aBelow = !G1a.passed && G1a.delta < T.G1a.min_delta;
  const pivotCondition = G3router.passed && G4router.passed && (g1aBelow || !G1b.passed);
  const inconclusive = G1a.delta >= T.inconclusive_zone.delta_min && G1a.ci_lower <= T.inconclusive_zone.ci_lower_max;
  const steps = [
    { n: 1, name: "NO-GO of the concept", rule: `the oracle arm loses ${stat === "point" ? "" : "(CI lower) "}more than ${-T.concept_no_go.oracle_delta_pp} pp against the full page, in any respondent`, observed: oracle, fires: conceptNoGo },
    { n: 2, name: "GO", rule: "G1a and G1b and G2 and G3 and G4", observed: { G1a: G1a.passed, G1b: G1b.passed, G2: G2.passed, G3: G3.passed, G4: G4.passed }, fires: G1a.passed && G1b.passed && G2.passed && G3.passed && G4.passed },
    { n: 3, name: "conditional GO", rule: "at least one eligible hard category, and G2, and G4 (overall), and G3 aggregated over the eligible categories", observed: { eligible, G2: G2.passed, G4: G4.passed, G3_on_eligible: G3eligible.passed }, fires: eligible.length > 0 && G2.passed && G4.passed && G3eligible.passed },
    { n: 4, name: "PIVOT", rule: "G3 and G4 hold for the router system, and (G1a fails with a delta under its threshold, or G1b fails)", observed: { G3_router: G3router.passed, G4_router: G4router.passed, G1a_fails_with_delta_below: g1aBelow, G1b_fails: !G1b.passed }, fires: pivotCondition },
    { n: 5, name: "NO-GO", rule: "otherwise", observed: {}, fires: true },
  ];
  let verdict;
  let firedBy;
  for (const st of steps) if (st.fires) { firedBy = st.n; break; }
  const flags = {
    inconclusive_zone: { raised: inconclusive, rule: `G1a delta >= ${T.inconclusive_zone.delta_min} and its CI lower bound <= ${T.inconclusive_zone.ci_lower_max}`, action: "the single pre-authorized extension: +40 hard pages (same sampling, captured >= 28 days later, 100% human labels), re-evaluate ONCE with the same code (alpha is not corrected; declare it); set extension_done in the evidence afterwards", extension_done: evidence.extension_done === true },
    gbdt_minus_mlp: { value: agg((o) => o.gbdt_minus_mlp), threshold: T.gbdt_minus_mlp_investigate_above, investigate: agg((o) => o.gbdt_minus_mlp) > T.gbdt_minus_mlp_investigate_above, note: "not a verdict: open a capacity/features investigation (the GBDT never ships); hard strata, test, mean over seeds" },
    d2_ml_is_not_the_source: G4.ml_is_not_the_source,
    g5_blocks_e4_until_optimized: !G5.passed,
    g6_forbids_logged_in_differentiator: !G6.passed,
  };
  if (firedBy === 1) verdict = "NO-GO-CONCEPT";
  else if (firedBy === 2) verdict = "GO";
  else if (firedBy === 3) verdict = "GO-CONDICIONAL";
  else if (inconclusive && evidence.extension_done !== true) verdict = "INCONCLUSIVO";
  else verdict = firedBy === 4 ? "PIVOT" : "NO-GO";
  const provisional = firedBy === 4 ? "PIVOT" : "NO-GO";
  flags.rescue_arm = {
    allowed: verdict === "NO-GO" && !G3.passed && evidence.rescue_done !== true,
    rule: "a NO-GO caused by G3 of the model alone (the oracle passed): ONE rescue arm with tau at recall >= the target, run only if triggered, reported as a second look",
    recall_target: T.rescue_arm.recall_target,
    rescue_done: evidence.rescue_done === true,
  };
  const pivotReason = firedBy === 4 ? [g1aBelow ? `G1a delta ${G1a.delta.toFixed(4)} < ${T.G1a.min_delta}` : null, !G1b.passed ? `G1b delta ${G1b.delta.toFixed(4)} < ${T.G1b.min_delta}` : null].filter(Boolean) : [];

  return {
    format: "gran-prix.decision",
    format_version: "1.0.0",
    protocol: config.protocol,
    verdict,
    rule_fired: firedBy,
    ...(verdict === "INCONCLUSIVO" ? { provisional_if_no_extension: provisional } : {}),
    ...(verdict === "PIVOT" || provisional === "PIVOT" ? { pivot_reason: pivotReason } : {}),
    steps,
    gates: { G0, G1a, G1b, G2, G3, G4, G5, G6, G3_router: G3router, G4_router: G4router, G3_on_eligible: G3eligible },
    categories: { eligible, detail: elig },
    flags,
    systems: { best_individual_in_dev: bestIndividual, best_by_stratum_in_dev: bestByStratum },
    seeds: { list: seeds, aggregation: config.seed_aggregation },
    inputs: meta,
  };
}

// ------------------------------------------------------------------------------------------------------------- CLI
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function loadEvidence(file) {
  const dir = dirname(resolve(file));
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const hashes = {};
  const load = (p, what) => {
    try {
      const full = resolve(dir, p);
      const bytes = readFileSync(full);
      hashes[what] = sha(bytes);
      return JSON.parse(bytes.toString("utf8"));
    } catch (e) {
      throw new DecisionInputError([`evidence ${what}: cannot read ${p}: ${e.message}`]);
    }
  };
  const evidence = {
    extension_done: manifest.extension_done === true,
    rescue_done: manifest.rescue_done === true,
  };
  for (const k of ["dev_oof", "router_tokens", "g5", "g6"]) if (manifest[k] !== undefined) evidence[k] = load(manifest[k], k);
  for (const k of ["test", "qa"]) if (manifest[k] !== undefined) evidence[k] = Object.fromEntries(Object.entries(manifest[k]).map(([id, p]) => [id, load(p, `${k}.${id}`)]));
  return { evidence, hashes };
}

export function main(argv) {
  const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const evidenceFile = opt("--evidence");
  if (evidenceFile === undefined) {
    process.stderr.write("usage: node scripts/decide-dom-v0.mjs --evidence <evidence.json> [--config <config.json>] [--out <dir>]\n");
    return 2;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const configFile = resolve(opt("--config", resolve(root, "pipelines/dom-v0-decision.json")));
  const out = resolve(opt("--out", "."));
  try {
    const configText = readFileSync(configFile, "utf8");
    const { evidence, hashes } = loadEvidence(evidenceFile);
    const decision = decide(evidence, JSON.parse(configText), { config_sha256: sha(configText), evidence_sha256: hashes });
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "decision.json"), `${JSON.stringify(decision, null, 2)}\n`);
    writeFileSync(resolve(out, "decision.md"), renderMarkdown(decision));
    process.stdout.write(`verdict: ${decision.verdict} (rule ${decision.rule_fired}); written to ${out}\n`);
    return 0;
  } catch (e) {
    if (e instanceof DecisionInputError) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
