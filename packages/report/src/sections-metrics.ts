import type { Prf } from "@gran-prix/contracts";
import { dotWhisker, legend, legendMarker, niceAxis, seriesFor, UNIT_AXIS, type DwRow, type Series } from "./charts.js";
import type { MetricCis } from "./extras.js";
import { ci, esc, int, num, pct, signed } from "./format.js";
import { absent, noteLine, numCell, section, tableWrap, th, tile, type Ctx, type Intrinsic, type Section } from "./ui.js";

const METRICS = [
  { key: "f1", label: "F1" },
  { key: "precision", label: "Precision" },
  { key: "recall", label: "Recall" },
] as const;
type MetricKey = (typeof METRICS)[number]["key"];

/** Series of the report: the model, then each baseline in the report's order. */
export function reportSeries(i: Intrinsic): Series[] {
  return seriesFor("Model", Object.keys(i.baselines));
}

function prfFor(i: Intrinsic, series: Series, stratum: string | null): Prf | undefined {
  if (series.cls === "s0") return stratum === null ? i.overall : i.by_stratum[stratum];
  const b = i.baselines[series.name];
  return stratum === null ? b?.overall : b?.by_stratum[stratum];
}

function cisFor(c: Ctx, series: Series, stratum: string | null): MetricCis | undefined {
  const key = stratum ?? "overall";
  return series.cls === "s0" ? c.x.metric_ci?.model?.[key] : c.x.metric_ci?.baselines?.[series.name]?.[key];
}

function overallTiles(i: Intrinsic): string {
  const o = i.overall;
  return `<div class="tiles">${[
    tile("Examples (n)", int(o.n)),
    tile("F1", num(o.f1)),
    tile("Precision", num(o.precision)),
    tile("Recall", num(o.recall)),
    tile("Accuracy", num(o.accuracy)),
    tile("ROC AUC", num(o.auc_roc)),
    tile("PR AUC", num(o.pr_auc)),
    tile("Log loss", num(o.logloss)),
    tile("Brier", num(o.brier)),
  ].join("")}</div>`;
}

/** Small-multiple dot-and-whisker panels: one per metric, rows = strata, one lane per system. */
function metricPanels(c: Ctx, i: Intrinsic, series: Series[]): string {
  const labels: (string | null)[] = [null, ...Object.keys(i.by_stratum)];
  const panels = METRICS.map((m) => {
    const rows: DwRow[] = labels.map((s) => ({
      label: s ?? "Overall",
      points: series.map((se) => {
        const p = prfFor(i, se, s);
        return p ? { value: p[m.key], ci: cisFor(c, se, s)?.[m.key] } : undefined;
      }),
    }));
    const svg = dotWhisker({
      id: `chart-${m.key}`,
      title: `${m.label} by stratum`,
      desc: `${m.label} of the model and each baseline for the overall data and each stratum, on a 0 to 1 axis.`,
      rows,
      series,
      domain: UNIT_AXIS.domain,
      ticks: UNIT_AXIS.ticks,
      axisLabel: `${m.label} (0 to 1, higher is better)`,
      decimals: 3,
    });
    return `<div class="panel"><h3>${m.label}</h3>${svg}</div>`;
  });
  return `${legend(series)}<div class="panels">${panels.join("")}</div>`;
}

function cell(p: Prf, k: MetricKey, cis: MetricCis | undefined): string {
  const c = cis?.[k];
  return numCell(num(p[k]), c ? ci(c) : undefined);
}

function strataTable(c: Ctx, i: Intrinsic, series: Series[]): string {
  const hasCi = c.x.metric_ci !== undefined;
  const labels: (string | null)[] = [null, ...Object.keys(i.by_stratum)];
  const body = labels
    .map((s) => {
      const rows = series.flatMap((se) => {
        const p = prfFor(i, se, s);
        if (!p) return [];
        const groups = s !== null && se.cls === "s0" ? int(i.by_stratum[s]?.n_groups ?? 0) : "—";
        return [{ se, p, groups }];
      });
      return `<tbody class="grp">${rows
        .map(({ se, p, groups }, idx) => {
          const head = idx === 0 ? `<th scope="rowgroup" rowspan="${rows.length}">${esc(s ?? "Overall")}</th>` : "";
          const cis = cisFor(c, se, s);
          return `<tr class="${se.cls === "s0" ? "model" : "base"}">${head}<td class="sys"><span class="sw">${legendMarker(se)}</span>${esc(se.name)}</td>${numCell(int(p.n))}${numCell(groups)}${cell(p, "precision", cis)}${cell(p, "recall", cis)}${cell(p, "f1", cis)}</tr>`;
        })
        .join("")}</tbody>`;
    })
    .join("");
  const caption = hasCi
    ? "Point estimate with 95% group-bootstrap CI below it. Groups (pages or domains) are resampled, never rows."
    : "Point estimates at the operating threshold. Per-stratum 95% CIs are not in this report.";
  return `<table><caption>${esc(caption)}</caption><thead><tr>${th("Stratum")}${th("System")}${th("n", true)}${th("Groups", true)}${th("Precision", true)}${th("Recall", true)}${th("F1", true)}</tr></thead>${body}</table>`;
}

/** Model-minus-baseline F1 per stratum with the report's group-bootstrap CI. */
function comparisonBlock(i: Intrinsic): string {
  if (i.comparison.length === 0) return absent("No model-versus-baseline comparison in this report.");
  const baselines = Object.keys(i.baselines);
  const series: Series[] = seriesFor("", baselines).slice(1).map((s) => ({ ...s, cls: "s0" }));
  const strata = [...new Set(i.comparison.map((e) => e.stratum))];
  const rows: DwRow[] = strata.map((s) => ({
    label: s,
    points: baselines.map((b) => {
      const e = i.comparison.find((x) => x.stratum === s && x.baseline === b);
      return e ? { value: e.delta, ci: e.ci95 } : undefined;
    }),
  }));
  const all = i.comparison.flatMap((e) => [e.ci95[0], e.ci95[1], e.delta]);
  const axis = niceAxis(Math.min(...all), Math.max(...all));
  const svg = dotWhisker({
    id: "chart-delta",
    title: "F1 difference, model minus baseline, by stratum",
    desc: "Dot is the F1 difference; the whisker is its 95% group-bootstrap confidence interval; the dashed line marks zero.",
    rows,
    series,
    domain: axis.domain,
    ticks: axis.ticks,
    axisLabel: "ΔF1 = model − baseline (95% CI; right of dashed line = model better)",
    decimals: 3,
    zeroLine: true,
  });
  const verdict = (e: Intrinsic["comparison"][number]): string =>
    e.ci95[0] > 0 ? "Yes: model better" : e.ci95[1] < 0 ? "Yes: baseline better" : "No";
  const body = i.comparison
    .map(
      (e) =>
        `<tr><th scope="row">${esc(e.stratum)}</th><td>${esc(e.baseline)}</td>${numCell(num(e.model))}${numCell(num(e.baseline_value))}${numCell(signed(e.delta))}${numCell(ci(e.ci95))}${numCell(int(e.n_groups))}<td>${verdict(e)}</td></tr>`,
    )
    .join("");
  const table = `<table><thead><tr>${th("Stratum")}${th("Baseline")}${th("Model F1", true)}${th("Baseline F1", true)}${th("ΔF1", true)}${th("95% CI of ΔF1", true)}${th("Groups", true)}${th("CI excludes 0")}</tr></thead><tbody>${body}</tbody></table>`;
  return `<h3>Model versus each baseline (F1)</h3>${legend(series)}<div class="panel">${svg}</div>${tableWrap(table)}`;
}

function labelSourceTable(i: Intrinsic): string {
  const entries = Object.entries(i.by_label_source);
  if (entries.length === 0) return "";
  const body = entries
    .map(([k, p]) => `<tr><th scope="row">${esc(k)}</th>${numCell(int(p.n))}${numCell(num(p.precision))}${numCell(num(p.recall))}${numCell(num(p.f1))}</tr>`)
    .join("");
  return `<h3>By label source</h3>${noteLine("Reported per labeler to expose circularity between the training labels and the measuring labels.")}${tableWrap(`<table><thead><tr>${th("Label source")}${th("n", true)}${th("Precision", true)}${th("Recall", true)}${th("F1", true)}</tr></thead><tbody>${body}</tbody></table>`)}`;
}

function worstGroups(i: Intrinsic, limit = 8): string {
  if (i.per_group.length === 0) return "";
  const sorted = [...i.per_group].sort((a, b) => a.f1 - b.f1 || a.group_id.localeCompare(b.group_id)).slice(0, limit);
  const body = sorted
    .map((g) => `<tr><th scope="row"><code>${esc(g.group_id)}</code></th><td>${esc(g.stratum)}</td>${numCell(num(g.f1))}${numCell(pct(g.kept_ratio))}</tr>`)
    .join("");
  return `<h3>Weakest groups</h3>${noteLine(`The ${Math.min(limit, i.per_group.length)} lowest-F1 groups of ${int(i.per_group.length)}. Start error analysis here.`)}${tableWrap(`<table><thead><tr>${th("Group")}${th("Stratum")}${th("F1", true)}${th("Kept share of tokens", true)}</tr></thead><tbody>${body}</tbody></table>`)}`;
}

/** (3) Per-stratum metrics: table plus dot-and-whisker, model against every baseline. */
export function strataSection(c: Ctx): Section | undefined {
  const i = c.r.intrinsic;
  if (!i) return undefined;
  const series = reportSeries(i);
  const body = [
    overallTiles(i),
    metricPanels(c, i, series),
    tableWrap(strataTable(c, i, series)),
    comparisonBlock(i),
    labelSourceTable(i),
    worstGroups(i),
  ].join("");
  return section("strata", "Metrics by stratum", body);
}

function matrix(p: Prf, threshold: number, title: string): string {
  const rowN = (a: number, b: number): number => a + b;
  const cellHtml = (count: number, total: number, hit: boolean): string => {
    const v = total > 0 ? count / total : 0;
    return `<td class="${hit ? "hit" : ""}" style="--v:${num(v, 2)}"><b>${int(count)}</b><span>${total > 0 ? pct(v) : "n/a"}</span></td>`;
  };
  const pos = rowN(p.tp, p.fn);
  const neg = rowN(p.fp, p.tn);
  return `<div class="panel"><h3>${esc(title)}</h3><table class="cm"><caption>n = ${int(p.n)}</caption><thead><tr><td></td><th scope="col">Predicted +</th><th scope="col">Predicted −</th></tr></thead><tbody><tr><th scope="row">Actual +</th>${cellHtml(p.tp, pos, true)}${cellHtml(p.fn, pos, false)}</tr><tr><th scope="row">Actual −</th>${cellHtml(p.fp, neg, false)}${cellHtml(p.tn, neg, true)}</tr></tbody></table><p class="cap">Prediction = score ≥ ${num(threshold, 2)}</p></div>`;
}

/** (4) Confusion matrices (counts and row-normalised), overall and per stratum, from tp/fp/tn/fn. */
export function confusionSection(c: Ctx): Section | undefined {
  const i = c.r.intrinsic;
  if (!i) return undefined;
  const panels = [matrix(i.overall, c.r.threshold, "Overall"), ...Object.entries(i.by_stratum).map(([s, p]) => matrix(p, c.r.threshold, s))];
  return section(
    "confusion",
    "Confusion matrix",
    `${noteLine("Positive (+) is the contract's positive class. Each cell shows the count and, below it, the share of its row (recall for the positive row, specificity for the negative row). The outlined cells are the correct predictions.")}<div class="cm-grid">${panels.join("")}</div>`,
  );
}
