import type { EvalReport } from "../eval-report.js";
import { contractId } from "../identity/contract-ids.js";
import { compare, type Gate } from "../stats.js";
import { Issues } from "./result.js";

const ciOk = (c: readonly [number, number]): boolean => c[0] <= c[1];

type Counts = { n: number; tp: number; fp: number; tn: number; fn: number };
type Intrinsic = NonNullable<EvalReport["intrinsic"]>;

/**
 * Structured-gate rules (v1.1 fields only, so a v1.0 gate is never affected): a gate cannot contradict
 * its own comparator / threshold / value, and a CI-bound gate must carry the CI it was decided on.
 */
export function gateIssues(g: Gate, at: string, out: Issues): void {
  const hasCmp = g.comparator !== undefined;
  const hasThr = g.threshold !== undefined;
  out.check(hasCmp === hasThr, hasCmp ? `${at}.threshold` : `${at}.comparator`, "comparator and threshold must be given together");
  if (g.ci95) out.check(ciOk(g.ci95), `${at}.ci95`, "ci95 must be [lo, hi] with lo <= hi");
  if (g.use_ci_lower) {
    out.check(g.ci95 !== undefined, `${at}.ci95`, "use_ci_lower requires ci95");
    out.check(g.comparator !== undefined && g.comparator !== "==", `${at}.comparator`, "use_ci_lower needs an ordering comparator (>=, >, <=, <)");
    if (g.ci95 && g.comparator && g.comparator !== "==") {
      const bound = g.comparator === ">=" || g.comparator === ">" ? g.ci95[0] : g.ci95[1];
      out.check(g.value === bound, `${at}.value`, `with use_ci_lower, value must be the CI bound facing the threshold (${bound}), got ${g.value}`);
    }
  } else if (g.observed !== undefined) {
    out.check(g.value === g.observed, `${at}.value`, `without use_ci_lower, value must equal observed (${g.observed}), got ${g.value}`);
  }
  if (g.comparator !== undefined && g.threshold !== undefined) {
    const expected = compare(g.value, g.comparator, g.threshold);
    out.check(g.passed === expected, `${at}.passed`, `value ${g.value} ${g.comparator} ${g.threshold} is ${expected}, but passed is ${g.passed}`);
  }
}

export function evalReportInvariants(r: EvalReport): Issues {
  const out = new Issues("eval-report");
  out.check(r.mode !== "intrinsic" || r.intrinsic !== undefined, "intrinsic", 'mode "intrinsic" requires the intrinsic section');
  out.check(r.mode !== "downstream" || r.downstream !== undefined, "downstream", 'mode "downstream" requires the downstream section');
  if (typeof r.split === "object") out.check(r.split.kfold.fold < r.split.kfold.k, "split.kfold.fold", "fold must be < k");

  const prf = (p: Counts, at: string): void =>
    out.check(p.tp + p.fp + p.tn + p.fn === p.n, at, `tp+fp+tn+fn (${p.tp + p.fp + p.tn + p.fn}) must equal n (${p.n})`);
  const i = r.intrinsic;
  if (i) {
    prf(i.overall, "intrinsic.overall");
    for (const [k, v] of Object.entries(i.by_stratum)) prf(v, `intrinsic.by_stratum.${k}`);
    for (const [k, v] of Object.entries(i.by_label_source)) prf(v, `intrinsic.by_label_source.${k}`);
    for (const [k, b] of Object.entries(i.baselines)) prf(b.overall, `intrinsic.baselines.${k}.overall`);
    const aggregateNames = new Set((i.aggregates ?? []).map((a) => a.name));
    i.comparison.forEach((c, j) => {
      const at = `intrinsic.comparison[${j}]`;
      out.check(ciOk(c.ci95), `${at}.ci95`, "ci95 must be [lo, hi] with lo <= hi");
      out.check(Math.abs(c.model - c.baseline_value - c.delta) < 1e-9, `${at}.delta`, "delta must equal model - baseline_value");
      out.check(c.baseline in i.baselines, `${at}.baseline`, `baseline "${c.baseline}" is not in intrinsic.baselines`);
      out.check(
        c.stratum in i.by_stratum || c.stratum === "overall" || aggregateNames.has(c.stratum),
        `${at}.stratum`,
        `stratum "${c.stratum}" is not in intrinsic.by_stratum (nor "overall" nor an intrinsic.aggregates name)`,
      );
    });
    intrinsicV11(r, i, out, prf);
  }
  const d = r.downstream;
  if (d) {
    d.paired_deltas.forEach((p, j) => {
      out.check(ciOk(p.ci95), `downstream.paired_deltas[${j}].ci95`, "ci95 must be [lo, hi] with lo <= hi");
      out.check(p.a in d.arms, `downstream.paired_deltas[${j}].a`, `arm "${p.a}" is not in downstream.arms`);
      out.check(p.b in d.arms, `downstream.paired_deltas[${j}].b`, `arm "${p.b}" is not in downstream.arms`);
    });
    for (const [k, arm] of Object.entries(d.arms)) {
      out.check(ciOk(arm.score_ci95), `downstream.arms.${k}.score_ci95`, "ci95 must be [lo, hi] with lo <= hi");
      const ci = arm.evidence_retention?.ci95;
      if (ci) out.check(ciOk(ci), `downstream.arms.${k}.evidence_retention.ci95`, "ci95 must be [lo, hi] with lo <= hi");
    }
  }
  const gateIds = (r.gates ?? []).map((g) => g.id);
  gateIds.forEach((id, j) => out.check(gateIds.indexOf(id) === j, `gates[${j}].id`, `duplicate gate id "${id}"`));
  (r.gates ?? []).forEach((g, j) => gateIssues(g, `gates[${j}]`, out));
  out.idCheck(r.report_id === contractId("eval-report", r), "report_id", "does not match the hash of the report (excluding report_id and provenance)");
  return out;
}

/** Rules for the optional v1.1 blocks of `intrinsic`. Every rule applies to a field v1.0 did not have. */
function intrinsicV11(r: EvalReport, i: Intrinsic, out: Issues, prf: (p: Counts, at: string) => void): void {
  for (const [k, v] of Object.entries(i.by_tag ?? {})) prf(v, `intrinsic.by_tag.${k}`);
  (i.aggregates ?? []).forEach((a, j) => a.micro && prf(a.micro, `intrinsic.aggregates[${j}].micro`));

  const aggNames = (i.aggregates ?? []).map((a) => a.name);
  (i.aggregates ?? []).forEach((a, j) => {
    const at = `intrinsic.aggregates[${j}]`;
    out.check(aggNames.indexOf(a.name) === j, `${at}.name`, `duplicate aggregate "${a.name}"`);
    a.strata.forEach((s, k) => out.check(s in i.by_stratum, `${at}.strata[${k}]`, `stratum "${s}" is not in intrinsic.by_stratum`));
    if (a.ci95) out.check(ciOk(a.ci95), `${at}.ci95`, "ci95 must be [lo, hi] with lo <= hi");
  });

  const mc = i.metric_ci;
  if (mc) {
    const checkTable = (t: Record<string, Record<string, readonly [number, number] | undefined>>, at: string): void => {
      for (const [s, cis] of Object.entries(t)) {
        out.check(s === "overall" || s in i.by_stratum, `${at}.${s}`, `stratum "${s}" is not "overall" nor in intrinsic.by_stratum`);
        for (const [m, ci] of Object.entries(cis)) if (ci) out.check(ciOk(ci), `${at}.${s}.${m}`, "ci95 must be [lo, hi] with lo <= hi");
      }
    };
    if (mc.model) checkTable(mc.model, "intrinsic.metric_ci.model");
    for (const [b, t] of Object.entries(mc.baselines ?? {})) {
      out.check(b in i.baselines, `intrinsic.metric_ci.baselines.${b}`, `baseline "${b}" is not in intrinsic.baselines`);
      checkTable(t, `intrinsic.metric_ci.baselines.${b}`);
    }
  }

  const pc = i.pr_curve;
  if (pc) {
    pc.points.forEach((p, j) => {
      const prev = pc.points[j - 1];
      if (prev) out.check(p.threshold >= prev.threshold, `intrinsic.pr_curve.points[${j}].threshold`, "points must be sorted by threshold ascending");
    });
    if (pc.operating_threshold !== undefined) {
      out.check(pc.operating_threshold === r.threshold, "intrinsic.pr_curve.operating_threshold", `must equal the report threshold (${r.threshold})`);
    }
  }

  for (const d of ["d1", "d2"] as const) {
    const den = i.token_reduction?.[d];
    if (!den) continue;
    const at = `intrinsic.token_reduction.${d}`;
    for (const k of ["iqr_ratio", "iqr_reduction"] as const) {
      const q = den[k];
      if (q) out.check(ciOk(q), `${at}.${k}`, "[q1, q3] must have q1 <= q3");
    }
    for (const [s, v] of Object.entries(den.by_stratum ?? {})) {
      for (const k of ["iqr_ratio", "iqr_reduction"] as const) {
        const q = v[k];
        if (q) out.check(ciOk(q), `${at}.by_stratum.${s}.${k}`, "[q1, q3] must have q1 <= q3");
      }
    }
  }

  i.per_group.forEach((g, j) => {
    for (const b of Object.keys(g.f1_by_baseline ?? {})) {
      out.check(b in i.baselines, `intrinsic.per_group[${j}].f1_by_baseline.${b}`, `baseline "${b}" is not in intrinsic.baselines`);
    }
  });
}
