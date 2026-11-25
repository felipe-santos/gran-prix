import type { Prf } from "@gran-prix/contracts";
import { dotWhisker, legend, legendMarker, seriesFor, UNIT_AXIS, type DwRow, type Series } from "./charts.js";
import type { MetricCis } from "./extras.js";
import { ci, esc, int, num, pct } from "./format.js";
import { aggregatesTable, byTagTable, comparisonBlock, methodsLine } from "./sections-methods.js";
import { noteLine, numCell, section, tableWrap, th, tile, type Ctx, type Intrinsic, type Section } from "./ui.js";

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

/** A baseline's coverage (share of pages it produced an output for), shown once, on its overall row. */
function coverageNote(i: Intrinsic, se: Series, stratum: string | null): string {
  const cov = se.cls === "s0" || stratum !== null ? undefined : i.baselines[se.name]?.coverage;
  return cov === undefined ? "" : `<span class="cov">coverage ${pct(cov)}</span>`;
}

function strataTable(c: Ctx, i: Intrinsic, series: Series[]): string {
  const hasCi = c.x.metric_ci !== undefined;
  const labels: (string | null)[] = [null, ...Object.keys(i.by_stratum)];
  const body = labels
    .map((s) => {
      const rows = series.flatMap((se) => {
        const p = prfFor(i, se, s);
        if (!p) return [];
        const ng = s === null ? undefined : se.cls === "s0" ? i.by_stratum[s]?.n_groups : i.baselines[se.name]?.by_stratum[s]?.n_groups;
        return [{ se, p, groups: ng === undefined ? "—" : int(ng) }];
      });
      return `<tbody class="grp">${rows
        .map(({ se, p, groups }, idx) => {
          const head = idx === 0 ? `<th scope="rowgroup" rowspan="${rows.length}">${esc(s ?? "Overall")}</th>` : "";
          const cis = cisFor(c, se, s);
          return `<tr class="${se.cls === "s0" ? "model" : "base"}">${head}<td class="sys"><span class="sw">${legendMarker(se)}</span>${esc(se.name)}${coverageNote(i, se, s)}</td>${numCell(int(p.n))}${numCell(groups)}${cell(p, "precision", cis)}${cell(p, "recall", cis)}${cell(p, "f1", cis)}</tr>`;
        })
        .join("")}</tbody>`;
    })
    .join("");
  const caption = hasCi
    ? "Point estimate with 95% group-bootstrap CI below it. Groups (pages or domains) are resampled, never rows."
    : "Point estimates at the operating threshold. Per-stratum 95% CIs are not in this report.";
  return `<table><caption>${esc(caption)}</caption><thead><tr>${th("Stratum")}${th("System")}${th("n", true)}${th("Groups", true)}${th("Precision", true)}${th("Recall", true)}${th("F1", true)}</tr></thead>${body}</table>`;
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
  const withKey = sorted.some((g) => g.group_key !== undefined);
  const body = sorted
    .map((g) => `<tr><th scope="row"><code>${esc(g.group_id)}</code></th>${withKey ? `<td>${esc(g.group_key ?? "—")}</td>` : ""}<td>${esc(g.stratum)}</td>${numCell(num(g.f1))}${numCell(pct(g.kept_ratio))}</tr>`)
    .join("");
  return `<h3>Weakest groups</h3>${noteLine(`The ${Math.min(limit, i.per_group.length)} lowest-F1 groups of ${int(i.per_group.length)}. Start error analysis here.`)}${tableWrap(`<table><thead><tr>${th("Group")}${withKey ? th("Group key") : ""}${th("Stratum")}${th("F1", true)}${th("Kept share of tokens", true)}</tr></thead><tbody>${body}</tbody></table>`)}`;
}

/** (3) Per-stratum metrics: table plus dot-and-whisker, model against every baseline. */
export function strataSection(c: Ctx): Section | undefined {
  const i = c.r.intrinsic;
  if (!i) return undefined;
  const series = reportSeries(i);
  const body = [
    methodsLine(i),
    overallTiles(i),
    metricPanels(c, i, series),
    tableWrap(strataTable(c, i, series)),
    aggregatesTable(i),
    comparisonBlock(i),
    byTagTable(i),
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
