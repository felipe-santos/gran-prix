import type { EvalReport, EvalSystem, Gate } from "@gran-prix/contracts";
import type { Ci, GateDetail, MetricCis, Note, PrPoint, ReportExtras } from "./extras.js";

/** Median / IQR of a per-page ratio, as the report states it (v1.1) or the sidecar does (kept/full only). */
export interface RatioSummary {
  n_pages?: number;
  median_ratio?: number;
  iqr_ratio?: Ci;
  median_reduction?: number;
  iqr_reduction?: Ci;
  pooled_ratio?: number;
}
export interface DenominatorView extends RatioSummary {
  full_tokens: number;
  kept_tokens: number;
  by_stratum?: Record<string, RatioSummary>;
  description?: string;
}

/**
 * What the sections actually read: every field of the v1.1 report that has a sidecar twin, taken
 * from the REPORT when it is there and from the optional sidecar only when it is not (a v1.0
 * report). The report always wins, field by field: the two sources are never mixed inside one
 * field (a report's `metric_ci` is not completed with the sidecar's).
 */
export interface Resolved {
  names?: { model?: string; dataset?: string };
  metric_ci?: { model?: Record<string, MetricCis>; baselines?: Record<string, Record<string, MetricCis>> };
  pr_curve?: { points: readonly PrPoint[]; operating_threshold?: number; operating_rule?: string };
  token_reduction?: { tokenizer?: string; converter?: string; d1?: DenominatorView; d2?: DenominatorView };
  /** Sidecar gate details; consulted per field only where the gate itself does not carry the field. */
  gate_details?: Record<string, GateDetail>;
  notes?: Note[];
  system?: EvalSystem;
  /** Which source each field came from; "none" when neither has it. */
  from: Record<"metric_ci" | "pr_curve" | "token_reduction" | "notes", "report" | "extras" | "none">;
}

type Source = "report" | "extras" | "none";
const pick = <T>(fromReport: T | undefined, fromExtras: T | undefined): { v: T | undefined; from: Source } =>
  fromReport !== undefined ? { v: fromReport, from: "report" } : fromExtras !== undefined ? { v: fromExtras, from: "extras" } : { v: undefined, from: "none" };

export function resolve(r: EvalReport, x: ReportExtras): Resolved {
  const i = r.intrinsic;
  const mci = pick(i?.metric_ci, x.metric_ci);
  const pr = pick(i?.pr_curve, x.pr_curve);
  const tok = pick(i?.token_reduction, x.token_reduction);
  const notes = pick(r.notes, x.notes);
  const out: Resolved = { from: { metric_ci: mci.from, pr_curve: pr.from, token_reduction: tok.from, notes: notes.from } };
  if (r.names || x.names) {
    const names: { model?: string; dataset?: string } = {};
    const model = r.names?.model ?? x.names?.model;
    const dataset = r.names?.dataset ?? x.names?.dataset;
    if (model !== undefined) names.model = model;
    if (dataset !== undefined) names.dataset = dataset;
    out.names = names;
  }
  if (mci.v) out.metric_ci = mci.v;
  if (pr.v) out.pr_curve = pr.v;
  if (tok.v) out.token_reduction = tok.v;
  if (x.gate_details) out.gate_details = x.gate_details;
  if (notes.v) out.notes = notes.v;
  if (r.system) out.system = r.system;
  return out;
}

/** A gate with every display field resolved: its own structured fields first, the sidecar's after. */
export interface GateView {
  gate: Gate;
  name?: string;
  /** Sidecar threshold in words, only when the gate has no structured comparator/threshold. */
  thresholdText?: string;
  ci95?: Ci;
}

export function gateView(g: Gate, details: Record<string, GateDetail> | undefined): GateView {
  const d = details?.[g.id];
  const structured = g.comparator !== undefined && g.threshold !== undefined;
  const view: GateView = { gate: g };
  const name = g.name ?? d?.name;
  if (name) view.name = name;
  if (!structured && d?.threshold) view.thresholdText = d.threshold;
  const ci = g.ci95 ?? d?.ci95;
  if (ci) view.ci95 = ci;
  return view;
}
