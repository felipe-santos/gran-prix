import { legend, xyChart, type Series } from "./charts.js";
import { ci as fmtCi, esc, int, num } from "./format.js";
import { reportSeries } from "./sections-metrics.js";
import { absent, noteLine, notInReport, numCell, section, tableWrap, th, type Ctx, type Section } from "./ui.js";

const TABLE_CAP = 40;

/** (5) PR curve with the operating threshold marked; baselines appear as single operating points. */
export function prSection(c: Ctx): Section | undefined {
  const i = c.r.intrinsic;
  if (!i) return undefined;
  const pts = c.x.pr_curve?.points;
  if (!pts || pts.length < 2) {
    return section(
      "pr",
      "Precision-recall curve",
      absent(`${notInReport(c, "PR curve points are", "carries only the summary PR AUC")} Summary PR AUC = ${num(i.overall.pr_auc)}.`),
    );
  }
  const sorted = [...pts].sort((a, b) => a.recall - b.recall || b.precision - a.precision);
  const op = i.overall;
  const nearest = pts.reduce((best, p) => (Math.abs(p.threshold - c.r.threshold) < Math.abs(best.threshold - c.r.threshold) ? p : best));
  const series = reportSeries(i);
  const baselineMarks = series
    .slice(1)
    .flatMap((s) => {
      const b = i.baselines[s.name]?.overall;
      return b ? [{ x: b.recall, y: b.precision, shape: s.shape, cls: s.cls, tip: `${s.name}: precision ${num(b.precision)}, recall ${num(b.recall)}` }] : [];
    });
  const svg = xyChart({
    id: "chart-pr",
    title: "Precision-recall curve",
    desc: `Precision against recall as the threshold varies. The operating threshold ${num(c.r.threshold, 2)} gives precision ${num(op.precision)} and recall ${num(op.recall)}. Baselines are single points.`,
    xLabel: "Recall (0 to 1)",
    yLabel: "Precision (0 to 1)",
    lines: [{ pts: sorted.map((p): [number, number] => [p.recall, p.precision]), cls: "s0" }],
    marks: [
      { x: op.recall, y: op.precision, shape: "circle", cls: "s0", ring: true, tip: `Operating point, threshold ${num(c.r.threshold, 2)}: precision ${num(op.precision)}, recall ${num(op.recall)}` },
      ...baselineMarks,
    ],
    labels: [{ x: op.recall, y: op.precision, text: `threshold ${num(c.r.threshold, 2)}: P ${num(op.precision)}, R ${num(op.recall)}` }],
  });
  const key: Series[] = [
    { name: "Model (PR curve)", shape: "circle", cls: "s0" },
    ...series.slice(1).map((s) => ({ ...s, name: `${s.name} (operating point)` })),
  ];
  const step = Math.max(1, Math.ceil(sorted.length / TABLE_CAP));
  const rows = sorted
    .filter((_, k) => k % step === 0)
    .map((p) => `<tr><td class="n">${num(p.threshold)}</td>${numCell(num(p.precision))}${numCell(num(p.recall))}</tr>`)
    .join("");
  const table = `<details><summary>Curve points (${int(pts.length)}${step > 1 ? `, every ${step}th shown` : ""})</summary>${tableWrap(`<table><thead><tr>${th("Threshold", true)}${th("Precision", true)}${th("Recall", true)}</tr></thead><tbody>${rows}</tbody></table>`)}</details>`;
  const rule = c.x.pr_curve?.operating_rule ? noteLine(`Operating point chosen by: ${c.x.pr_curve.operating_rule}.`) : "";
  const gap = Math.abs(nearest.threshold - c.r.threshold) > 0.05 ? noteLine(`No curve point within 0.05 of the operating threshold; the marked point comes from the evaluation at ${num(c.r.threshold, 2)}.`) : "";
  return section(
    "pr",
    "Precision-recall curve",
    `${legend(key)}<div class="panel">${svg}</div>${noteLine(`PR AUC ${num(op.pr_auc)}. The ringed point is the operating threshold ${num(c.r.threshold, 2)} used for every number in this report.`)}${rule}${gap}${table}`,
  );
}

/** Reliability diagram and ECE from the contract's calibration bins. Omitted when absent. */
export function calibrationSection(c: Ctx): Section | undefined {
  const cal = c.r.intrinsic?.calibration;
  if (!cal) return undefined;
  const usable = cal.bins.filter((b) => b.n > 0);
  const svg = xyChart({
    id: "chart-cal",
    title: "Reliability diagram",
    desc: `Observed positive fraction against mean predicted probability per bin. Expected calibration error ${num(cal.ece)}.`,
    xLabel: "Mean predicted probability (0 to 1)",
    yLabel: "Observed positive fraction (0 to 1)",
    lines: [
      { pts: [[0, 0], [1, 1]], cls: "s2", dashed: true },
      { pts: usable.map((b): [number, number] => [b.mean_p, b.frac_pos]), cls: "s0" },
    ],
    marks: usable.map((b) => ({ x: b.mean_p, y: b.frac_pos, shape: "circle" as const, cls: "s0", tip: `bin ${num(b.lo, 2)} to ${num(b.hi, 2)}: n ${b.n}, predicted ${num(b.mean_p)}, observed ${num(b.frac_pos)}` })),
  });
  const rows = cal.bins
    .map((b) => `<tr><td>${esc(fmtCi([b.lo, b.hi], 2))}</td>${numCell(int(b.n))}${numCell(num(b.mean_p))}${numCell(num(b.frac_pos))}</tr>`)
    .join("");
  const table = tableWrap(`<table><thead><tr>${th("Bin")}${th("n", true)}${th("Mean predicted", true)}${th("Observed positive", true)}</tr></thead><tbody>${rows}</tbody></table>`);
  return section(
    "calibration",
    "Calibration",
    `<p>Expected calibration error (ECE): <strong>${num(cal.ece)}</strong>. Points on the dashed diagonal are perfectly calibrated.</p><div class="panels"><div class="panel">${svg}</div><div>${table}</div></div>`,
  );
}
