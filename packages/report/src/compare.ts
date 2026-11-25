import type { EvalReport, Prf } from "@gran-prix/contracts";
import { esc, num, shortId, signed } from "./format.js";
import { absent, codeId, kv, noteLine, numCell, section, statusBadge, tableWrap, th, type Ctx, type Section } from "./ui.js";

function direction(delta: number): string {
  return Math.abs(delta) < 0.0005 ? "same" : delta > 0 ? "better" : "worse";
}

function splitText(r: EvalReport): string {
  return typeof r.split === "string" ? r.split : `kfold ${r.split.kfold.fold + 1}/${r.split.kfold.k}`;
}

/**
 * Side-by-side with a second EvalReport (`--compare`). Refuses to compute deltas when the two
 * reports were measured on different datasets: such numbers are not comparable.
 */
export function comparisonSection(c: Ctx, other: EvalReport): Section {
  const a = c.r;
  const idRows = kv([
    ["This report", codeId(a.report_id)],
    ["Other report", codeId(other.report_id)],
  ]);
  if (a.dataset_id !== other.dataset_id) {
    return section(
      "comparison",
      `Comparison with ${shortId(other.report_id)}`,
      `<div class="banner fail" role="alert">${statusBadge(false)} Comparison blocked: the reports use different datasets</div>${kv([
        ["This dataset", codeId(a.dataset_id)],
        ["Other dataset", codeId(other.dataset_id)],
      ])}${noteLine("F1 differences across datasets mix model quality with data difficulty, so no deltas are shown.")}`,
    );
  }
  const warnings: string[] = [];
  if (splitText(a) !== splitText(other)) warnings.push(`splits differ (${splitText(a)} vs ${splitText(other)})`);
  if (a.threshold !== other.threshold) warnings.push(`operating thresholds differ (${num(a.threshold, 2)} vs ${num(other.threshold, 2)})`);
  if (a.model_id === other.model_id) warnings.push("both reports are for the same model");
  const warn = warnings.length ? `<div class="banner warn" role="status">Check before reading the deltas: ${esc(warnings.join("; "))}.</div>` : "";

  const ai = a.intrinsic;
  const bi = other.intrinsic;
  let table: string;
  if (ai && bi) {
    const strata = [...new Set([...Object.keys(ai.by_stratum), ...Object.keys(bi.by_stratum)])];
    const pick = (r: NonNullable<EvalReport["intrinsic"]>, s: string | null): Prf | undefined => (s === null ? r.overall : r.by_stratum[s]);
    const rows = [null, ...strata]
      .map((s) => {
        const pa = pick(ai, s);
        const pb = pick(bi, s);
        if (!pa || !pb) return `<tr><th scope="row">${esc(s ?? "Overall")}</th><td colspan="6" class="muted">only in one of the reports</td></tr>`;
        const d = pa.f1 - pb.f1;
        return `<tr><th scope="row">${esc(s ?? "Overall")}</th>${numCell(num(pa.f1))}${numCell(num(pb.f1))}${numCell(signed(d))}${numCell(signed(pa.precision - pb.precision))}${numCell(signed(pa.recall - pb.recall))}<td>${direction(d)}</td></tr>`;
      })
      .join("");
    table = tableWrap(
      `<table><caption>Differences are this report minus the other report, on the same dataset. Point estimates only: the contract has no CI for this contrast.</caption><thead><tr>${th("Stratum")}${th("F1, this", true)}${th("F1, other", true)}${th("ΔF1", true)}${th("Δ precision", true)}${th("Δ recall", true)}${th("F1 is")}</tr></thead><tbody>${rows}</tbody></table>`,
    );
  } else {
    table = absent("Intrinsic metrics are missing in one of the reports, so no metric deltas are shown.");
  }

  const ids = [...new Set([...(a.gates ?? []).map((g) => g.id), ...(other.gates ?? []).map((g) => g.id)])];
  const gateCell = (r: EvalReport, id: string): string => {
    const g = r.gates?.find((x) => x.id === id);
    return g ? `${statusBadge(g.passed)} <span class="muted">${num(g.value)}</span>` : '<span class="muted">not in report</span>';
  };
  const gates = ids.length
    ? `<h3>Gates</h3>${tableWrap(`<table><thead><tr>${th("Gate")}${th("This report")}${th("Other report")}</tr></thead><tbody>${ids.map((id) => `<tr><th scope="row"><code>${esc(id)}</code></th><td>${gateCell(a, id)}</td><td>${gateCell(other, id)}</td></tr>`).join("")}</tbody></table>`)}`
    : "";
  return section("comparison", `Comparison with ${shortId(other.report_id)}`, `${warn}${idRows}${table}${gates}`);
}
