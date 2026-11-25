// Synthetic evidence for scripts/decide-dom-v0.mjs: EvalReports that satisfy the contract (checked by the tests with
// assertValid) and whose per-page F1, comparison[], QA arms, token reductions and runtime are set by a scenario, so every
// branch of the rules of section 11 can be reached on purpose. Nothing here claims anything about quality.
import { assertValid, contractId } from "@gran-prix/contracts";

export const CATS = ["product", "docs", "forum", "landing", "spa"] as const;
export const INDIVIDUAL = ["readability", "trafilatura-precision", "trafilatura-default", "trafilatura-recall", "defuddle-default", "defuddle-no-low-scoring"];
export const SEEDS = [1, 2, 3, 4, 5];
const HASH = (c: string): `sha256:${string}` => `sha256:${c.repeat(64)}`;

type Num = number;
export interface Scn {
  /** F1 of the baselines per page, by stratum kind (hard / article). dev and test use the same values. */
  base: Record<string, { hard: Num; article: Num }>;
  gbdtHard: Num;
  /** F1 of the MLP on each TEST hard page: (category, page index) -> F1. */
  mlpHard: (c: string, i: number) => Num;
  mlpArticle: Num;
  /** F1 of the MLP's OOF on the dev pages (articles; hard is irrelevant for the rules). */
  mlpDevArticle: Num;
  /** [lo, hi] of the comparison "hard" vs the best individual baseline. */
  g1aCi: (delta: Num) => [Num, Num];
  /** Per respondent: paired deltas (fractions) and CI lower bounds. */
  qa: { model: [Num, Num, Num]; oracle: [Num, Num, Num]; router: [Num, Num, Num]; retention: Num; routerRetention: Num; categoryDelta: (c: string) => Num; categoryRetention: (c: string) => Num };
  d1: Num;
  d2: Num;
  d2By: (c: string) => Num;
  routerD1: Num;
  routerD2: Num;
  g5: { p95_ms: Num; model_bytes: Num; n_pages: Num; cpu_throttle: Num; repetitions: Num };
  g6: { vsReadability: Num; vsDefuddle: Num; share: Num; pages: Num };
}

export const GO: Scn = {
  base: {
    readability: { hard: 0.6, article: 0.8 },
    "trafilatura-precision": { hard: 0.5, article: 0.7 },
    "trafilatura-default": { hard: 0.55, article: 0.85 },
    "trafilatura-recall": { hard: 0.5, article: 0.7 },
    "defuddle-default": { hard: 0.5, article: 0.7 },
    "defuddle-no-low-scoring": { hard: 0.5, article: 0.7 },
    "router-oracle": { hard: 0.62, article: 0.82 },
  },
  gbdtHard: 0.65,
  mlpHard: () => 0.68,
  mlpArticle: 0.84,
  mlpDevArticle: 0.84,
  g1aCi: (d) => [d - 0.05, d + 0.05],
  qa: { model: [-0.01, -0.03, 0.01], oracle: [-0.002, -0.01, 0.01], router: [-0.02, -0.04, 0], retention: 0.97, routerRetention: 0.96, categoryDelta: () => -0.01, categoryRetention: () => 0.97 },
  d1: 14,
  d2: 3.1,
  d2By: () => 2.5,
  routerD1: 12,
  routerD2: 2.2,
  g5: { p95_ms: 90, model_bytes: 40000, n_pages: 24, cpu_throttle: 4, repetitions: 3 },
  g6: { vsReadability: 0.01, vsDefuddle: 0, share: 0.9, pages: 12 },
};

export const merge = <T extends object>(a: T, b: Partial<T>): T => ({ ...a, ...b });

const PRF = { n: 100, tp: 40, fp: 10, tn: 40, fn: 10, precision: 0.8, recall: 0.8, f1: 0.8, accuracy: 0.8 };
const PROVENANCE = {
  produced_by: { run_id: "deterministic", stage_id: "eval", kind: "evaluate", impl: "ts:evaluate.intrinsic@1.0.0", params_sha256: HASH("1"), cache_key: HASH("2") },
  inputs: [],
  pipeline_spec_id: HASH("0"),
  tool_versions: { gp_cli: "0.0.0", node: "v0" },
  created_at: "1970-01-01T00:00:00Z",
  duration_ms: 0,
};

interface Page {
  id: string;
  key: string;
  stratum: string;
  f1: Num;
  by: Record<string, Num>;
}

const mean = (xs: Num[]): Num => xs.reduce((a, b) => a + b, 0) / xs.length;

/** An intrinsic EvalReport around `pages`: strata, the "hard" aggregate, a comparison[] for every baseline and stratum. */
function intrinsic(pages: Page[], baselineIds: string[], extra: { ci?: (stratum: string, baseline: string, delta: Num) => [Num, Num]; token?: object; runtime?: object; gates?: object[]; aggregates?: boolean }): object {
  const strata = [...new Set(pages.map((p) => p.stratum))].sort();
  const byStratum = Object.fromEntries(strata.map((s) => [s, { ...PRF, n_groups: pages.filter((p) => p.stratum === s).length }]));
  const hard = pages.filter((p) => (CATS as readonly string[]).includes(p.stratum));
  const comparison: object[] = [];
  const scopes: Array<[string, Page[]]> = [...strata.map((s): [string, Page[]] => [s, pages.filter((p) => p.stratum === s)]), ["overall", pages]];
  if (extra.aggregates !== false && hard.length > 0) scopes.push(["hard", hard]);
  for (const b of baselineIds)
    for (const [name, ps] of scopes) {
      const covered = ps.filter((p) => p.by[b] !== undefined);
      if (covered.length === 0) continue;
      const m = mean(covered.map((p) => p.f1));
      const bv = mean(covered.map((p) => p.by[b] as Num));
      const delta = m - bv;
      const ci = extra.ci?.(name, b, delta) ?? [delta - 0.02, delta + 0.02];
      comparison.push({ stratum: name, metric: "f1", model: m, baseline: b, baseline_value: bv, delta, ci95: ci, n_groups: covered.length, aggregation: "macro_page" });
    }
  return {
    overall: { ...PRF, auc_roc: 0.9, pr_auc: 0.9, logloss: 0.3, brier: 0.1 },
    by_stratum: byStratum,
    by_label_source: { human: PRF },
    baselines: Object.fromEntries(baselineIds.map((b) => [b, { coverage: 1, overall: PRF, by_stratum: Object.fromEntries(strata.map((s) => [s, PRF])) }])),
    comparison,
    ...(extra.aggregates !== false && hard.length > 0 ? { aggregates: [{ name: "hard", strata: [...CATS].filter((c) => strata.includes(c)) }] } : {}),
    per_group: pages.map((p) => ({ group_id: p.id, stratum: p.stratum, f1: p.f1, kept_ratio: 0.5, group_key: p.key, n_chars: 1000, f1_by_baseline: p.by })),
    ...(extra.token ? { token_reduction: extra.token } : {}),
    ...(extra.runtime ? { runtime: extra.runtime } : {}),
  };
}

function wrap(body: Record<string, unknown>): object {
  const full = { format: "gran-prix.eval-report", format_version: "1.1.0", model_id: HASH("a"), dataset_id: HASH("b"), threshold: 0.5, provenance: PROVENANCE, ...body };
  const doc = { ...full, report_id: contractId("eval-report", full) };
  assertValid("eval-report", doc);
  return doc;
}

const allBaselines = (s: Scn): string[] => [...INDIVIDUAL, "router-oracle", "gbdt"].filter((b) => b === "gbdt" || s.base[b] !== undefined);
const baseOf = (s: Scn, b: string, stratumKind: "hard" | "article"): Num => (b === "gbdt" ? (stratumKind === "hard" ? s.gbdtHard : 0.86) : (s.base[b] as { hard: Num; article: Num })[stratumKind]);

/** Two pages per hard category, three articles; every page its own domain. */
function skeleton(prefix: string): Array<{ id: string; key: string; stratum: string; i: number }> {
  return [
    ...CATS.flatMap((c) => [0, 1].map((i) => ({ id: `${prefix}-${c}-${i}`, key: `${prefix}-${c}${i}.example`, stratum: c, i }))),
    ...[0, 1, 2].map((i) => ({ id: `${prefix}-article-${i}`, key: `${prefix}-article${i}.example`, stratum: "article", i })),
  ];
}

export function devReport(s: Scn): object {
  const pages: Page[] = skeleton("dev").map((p) => {
    const kind = p.stratum === "article" ? "article" : "hard";
    const by: Record<string, Num> = Object.fromEntries(allBaselines(s).map((b) => [b, baseOf(s, b, kind)]));
    for (const k of SEEDS) by[`mlp-s${k}`] = kind === "article" ? s.mlpDevArticle : 0.68;
    return { id: p.id, key: p.key, stratum: p.stratum, f1: 0.7, by };
  });
  return wrap({ mode: "intrinsic", split: "all", intrinsic: intrinsic(pages, [...allBaselines(s), ...SEEDS.map((k) => `mlp-s${k}`)], {}) });
}

const tokenOf = (d1: Num, d2: Num, by: (c: string) => Num): object => ({
  tokenizer: "cl100k_base",
  d1: { full_tokens: 1000, kept_tokens: 100, median_reduction: d1 },
  d2: { full_tokens: 500, kept_tokens: 160, median_reduction: d2, by_stratum: Object.fromEntries(CATS.map((c) => [c, { median_reduction: by(c) }])) },
});

export function testReport(s: Scn, seed: number): object {
  const pages: Page[] = skeleton("test").map((p) => {
    const kind = p.stratum === "article" ? "article" : "hard";
    const by: Record<string, Num> = Object.fromEntries(allBaselines(s).map((b) => [b, baseOf(s, b, kind)]));
    return { id: p.id, key: p.key, stratum: p.stratum, f1: kind === "article" ? s.mlpArticle : s.mlpHard(p.stratum, p.i), by };
  });
  const best = "readability";
  return wrap({
    mode: "intrinsic",
    split: "test",
    intrinsic: intrinsic(pages, allBaselines(s), {
      ci: (stratum, baseline, delta) => (stratum === "hard" && baseline === best ? s.g1aCi(delta) : [delta - 0.02, delta + 0.02]),
      token: tokenOf(s.d1, s.d2, s.d2By),
    }),
    names: { model: `mlp-s${seed}` },
  });
}

export function routerTokensReport(s: Scn): object {
  const pages: Page[] = [{ id: "r0", key: "r0.example", stratum: "docs", f1: 0.6, by: {} }];
  return wrap({ mode: "intrinsic", split: "test", intrinsic: intrinsic(pages, [], { token: tokenOf(s.routerD1, s.routerD2, () => s.routerD2), aggregates: false }) });
}

export function g5Report(s: Scn): object {
  const pages: Page[] = [{ id: "p0", key: "p0.example", stratum: "docs", f1: 0.6, by: {} }];
  return wrap({ mode: "intrinsic", split: "test", intrinsic: intrinsic(pages, [], { runtime: { ...s.g5 }, aggregates: false }) });
}

export function g6Report(s: Scn): object {
  const pages: Page[] = Array.from({ length: s.g6.pages }, (_, i) => ({ id: `lg-${i}`, key: `lg${i}.example`, stratum: "docs", f1: 0.7, by: { readability: 0.7 - s.g6.vsReadability, "defuddle-default": 0.7 - s.g6.vsDefuddle } }));
  const gate = { id: "G6_inaccessible_share", rule: "share of logged-in pages that a plain GET cannot reach >= 0.8", value: s.g6.share, passed: s.g6.share >= 0.8, comparator: ">=", threshold: 0.8, observed: s.g6.share };
  return wrap({ mode: "intrinsic", split: "test", intrinsic: intrinsic(pages, ["readability", "defuddle-default"], { aggregates: false }), gates: [gate] });
}

export function qaReport(s: Scn): object {
  const arm = (score: Num, retention?: object): object => ({ n: 90, score_mean: score, score_ci95: [score - 0.05, score + 0.05], tokens_in_mean: 1000, cost_usd: 1, ...(retention ? { evidence_retention: retention } : {}) });
  const byStratum = (mean: (c: string) => Num): object => Object.fromEntries(CATS.map((c) => [c, { mean: mean(c), n_questions: 90 }]));
  const delta = (a: string, b: string, [d, lo, hi]: [Num, Num, Num]): object => ({ a, b, mean_delta: d, ci95: [lo, hi] });
  const arms = {
    full_page: arm(0.9),
    pruned_model: arm(0.89, { mean: s.qa.retention, by_stratum: byStratum(s.qa.categoryRetention) }),
    pruned_router: arm(0.88, { mean: s.qa.routerRetention }),
    oracle: arm(0.9, { mean: 1 }),
  };
  const paired = [
    delta("pruned_model", "full_page", s.qa.model),
    delta("oracle", "full_page", s.qa.oracle),
    delta("pruned_router", "full_page", s.qa.router),
    ...CATS.map((c) => delta(`pruned_model@${c}`, `full_page@${c}`, [s.qa.categoryDelta(c), s.qa.categoryDelta(c) - 0.03, s.qa.categoryDelta(c) + 0.03])),
  ];
  const named = Object.fromEntries(CATS.flatMap((c) => [[`pruned_model@${c}`, arm(0.89)], [`full_page@${c}`, arm(0.9)]]));
  return wrap({ mode: "downstream", split: "test", downstream: { task_set_id: HASH("c"), llm: { model: "respondent", prompt_sha256: HASH("d") }, judge: { kind: "exact" }, arms: { ...arms, ...named }, paired_deltas: paired } });
}

export interface Evidence {
  dev_oof: object;
  test: Record<string, object>;
  qa: { r1: object; r2: object };
  router_tokens: object;
  g5: object;
  g6: object;
  extension_done?: boolean;
  rescue_done?: boolean;
}

export function evidenceOf(s: Scn): Evidence {
  return {
    dev_oof: devReport(s),
    test: Object.fromEntries(SEEDS.map((k) => [String(k), testReport(s, k)])),
    qa: { r1: qaReport(s), r2: qaReport(s) },
    router_tokens: routerTokensReport(s),
    g5: g5Report(s),
    g6: g6Report(s),
  };
}
