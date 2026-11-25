/**
 * Report extras: data the report can show but that EvalReport v1.0.0 cannot carry.
 *
 * The EvalReport contract has no per-stratum confidence intervals, no PR-curve points, no
 * D1/D2 token denominators, no gate thresholds or CIs, no human-readable names and no notes
 * or threats. These are PROPOSED contract additions (see the package README). Until the
 * contract grows them, they travel in a separate sidecar document that is NOT part of the
 * report's content id: `gp-report --extras extras.json` or `renderReport(report, { extras })`.
 * Every field is optional; a section whose data is absent is omitted or shown as one line.
 */

export type Ci = readonly [number, number];

export interface MetricCis {
  precision?: Ci;
  recall?: Ci;
  f1?: Ci;
}

export interface PrPoint {
  threshold: number;
  precision: number;
  recall: number;
}

export interface TokenDenominator {
  /** Tokens of the denominator document (D1: raw outerHTML; D2: whole-page markdown). */
  full_tokens: number;
  /** Tokens kept by the model. */
  kept_tokens: number;
  /** Median of the per-page kept/full ratio, when the study reports it (A3 M5: median and IQR). */
  median_ratio?: number;
  iqr_ratio?: Ci;
}

export interface GateDetail {
  /** Human name, e.g. "G1 F1 gain on hard strata". */
  name?: string;
  /** The threshold in words, e.g. ">= +0.05". Shown instead of the contract's `rule` string when present. */
  threshold?: string;
  ci95?: Ci;
}

export interface Note {
  kind: "note" | "threat";
  text: string;
}

export interface ReportExtras {
  names?: { model?: string; dataset?: string };
  /** Group-bootstrap CIs per stratum ("overall" is allowed). */
  metric_ci?: {
    model?: Record<string, MetricCis>;
    baselines?: Record<string, Record<string, MetricCis>>;
  };
  pr_curve?: { points: PrPoint[] };
  token_reduction?: { tokenizer?: string; d1?: TokenDenominator; d2?: TokenDenominator };
  gate_details?: Record<string, GateDetail>;
  notes?: Note[];
}

export class ExtrasError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`invalid extras: ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? "; ..." : ""}`);
    this.name = "ExtrasError";
    this.issues = issues;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

class Check {
  readonly issues: string[] = [];
  fail(at: string, msg: string): void {
    this.issues.push(`${at}: ${msg}`);
  }
  obj(v: unknown, at: string): Obj | undefined {
    if (isObj(v)) return v;
    this.fail(at, "expected an object");
    return undefined;
  }
  num(v: unknown, at: string, min?: number, max?: number): v is number {
    if (!isNum(v) || (min !== undefined && v < min) || (max !== undefined && v > max)) {
      this.fail(at, `expected a number${min !== undefined ? ` in [${min}, ${max ?? "inf"}]` : ""}`);
      return false;
    }
    return true;
  }
  ci(v: unknown, at: string): boolean {
    if (Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]) && v[0] <= v[1]) return true;
    this.fail(at, "expected [lo, hi] with lo <= hi");
    return false;
  }
  str(v: unknown, at: string): v is string {
    if (typeof v === "string") return true;
    this.fail(at, "expected a string");
    return false;
  }
}

function checkMetricCis(c: Check, v: unknown, at: string): void {
  const o = c.obj(v, at);
  if (!o) return;
  for (const k of ["precision", "recall", "f1"]) if (o[k] !== undefined) c.ci(o[k], `${at}.${k}`);
}

function checkDenominator(c: Check, v: unknown, at: string): void {
  const o = c.obj(v, at);
  if (!o) return;
  c.num(o["full_tokens"], `${at}.full_tokens`, 1);
  c.num(o["kept_tokens"], `${at}.kept_tokens`, 0);
  if (o["median_ratio"] !== undefined) c.num(o["median_ratio"], `${at}.median_ratio`, 0);
  if (o["iqr_ratio"] !== undefined) c.ci(o["iqr_ratio"], `${at}.iqr_ratio`);
}

/** Validates a sidecar document. Throws `ExtrasError` listing every problem; never repairs. */
export function parseExtras(input: unknown): ReportExtras {
  const c = new Check();
  const root = c.obj(input, "$");
  if (!root) throw new ExtrasError(c.issues);

  if (root["names"] !== undefined) {
    const n = c.obj(root["names"], "names");
    for (const k of ["model", "dataset"]) if (n && n[k] !== undefined) c.str(n[k], `names.${k}`);
  }
  if (root["metric_ci"] !== undefined) {
    const m = c.obj(root["metric_ci"], "metric_ci");
    if (m?.["model"] !== undefined) {
      const model = c.obj(m["model"], "metric_ci.model");
      for (const [s, v] of Object.entries(model ?? {})) checkMetricCis(c, v, `metric_ci.model.${s}`);
    }
    if (m?.["baselines"] !== undefined) {
      const b = c.obj(m["baselines"], "metric_ci.baselines");
      for (const [name, strata] of Object.entries(b ?? {})) {
        const o = c.obj(strata, `metric_ci.baselines.${name}`);
        for (const [s, v] of Object.entries(o ?? {})) checkMetricCis(c, v, `metric_ci.baselines.${name}.${s}`);
      }
    }
  }
  if (root["pr_curve"] !== undefined) {
    const p = c.obj(root["pr_curve"], "pr_curve");
    const pts = p?.["points"];
    if (!Array.isArray(pts) || pts.length < 2) c.fail("pr_curve.points", "expected an array with at least 2 points");
    else
      pts.forEach((pt, i) => {
        const o = c.obj(pt, `pr_curve.points[${i}]`);
        if (!o) return;
        c.num(o["threshold"], `pr_curve.points[${i}].threshold`, 0, 1);
        c.num(o["precision"], `pr_curve.points[${i}].precision`, 0, 1);
        c.num(o["recall"], `pr_curve.points[${i}].recall`, 0, 1);
      });
  }
  if (root["token_reduction"] !== undefined) {
    const t = c.obj(root["token_reduction"], "token_reduction");
    if (t?.["tokenizer"] !== undefined) c.str(t["tokenizer"], "token_reduction.tokenizer");
    for (const k of ["d1", "d2"]) if (t?.[k] !== undefined) checkDenominator(c, t[k], `token_reduction.${k}`);
  }
  if (root["gate_details"] !== undefined) {
    const g = c.obj(root["gate_details"], "gate_details");
    for (const [id, v] of Object.entries(g ?? {})) {
      const o = c.obj(v, `gate_details.${id}`);
      if (!o) continue;
      for (const k of ["name", "threshold"]) if (o[k] !== undefined) c.str(o[k], `gate_details.${id}.${k}`);
      if (o["ci95"] !== undefined) c.ci(o["ci95"], `gate_details.${id}.ci95`);
    }
  }
  if (root["notes"] !== undefined) {
    if (!Array.isArray(root["notes"])) c.fail("notes", "expected an array");
    else
      root["notes"].forEach((n, i) => {
        const o = c.obj(n, `notes[${i}]`);
        if (!o) return;
        if (o["kind"] !== "note" && o["kind"] !== "threat") c.fail(`notes[${i}].kind`, 'expected "note" or "threat"');
        c.str(o["text"], `notes[${i}].text`);
      });
  }
  if (c.issues.length > 0) throw new ExtrasError(c.issues);
  return input as ReportExtras;
}
