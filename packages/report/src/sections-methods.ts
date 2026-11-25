import type { Prf } from "@gran-prix/contracts";
import { dotWhisker, legend, niceAxis, seriesFor, type DwRow, type Series } from "./charts.js";
import { ci, esc, int, num, signed } from "./format.js";
import { absent, noteLine, numCell, tableWrap, th, type Intrinsic } from "./ui.js";

const METRIC_LABEL: Record<string, string> = { f1: "F1", precision: "Precision", recall: "Recall", token_f1: "Token F1", qa_accuracy: "QA accuracy" };
const AGG_LABEL: Record<string, string> = { micro: "micro", macro_page: "macro by page", macro_stratum: "macro by stratum" };
type Cmp = Intrinsic["comparison"][number];
type Bootstrap = NonNullable<Intrinsic["bootstrap"]>;

/** The one-sentence description of a bootstrap, shared by the intrinsic and downstream methods lines. */
export function bootstrapText(b: Bootstrap): string {
  const unit = b.cluster_by === "group_key" ? "registrable domains (group_key)" : "pages (group_id)";
  return `${b.method} bootstrap, ${int(b.resamples)} resamples, seed ${b.seed}, resampling ${unit}${b.stratified ? " inside each stratum" : ""}`;
}

/** How the numbers were counted and how the CIs were made (EvalReport v1.1 `weighting` and `bootstrap`). */
export function methodsLine(i: Intrinsic): string {
  const parts: string[] = [];
  const w = i.weighting;
  if (w) {
    const extra = [w.positive_class ? `positive class: ${w.positive_class}` : "", w.weight_source ? `weights: ${w.weight_source}` : ""].filter(Boolean);
    parts.push(`Counts are in ${w.unit}${extra.length ? ` (${extra.join("; ")})` : ""}.`);
  }
  if (i.bootstrap) parts.push(`CIs: ${bootstrapText(i.bootstrap)}.`);
  return parts.length ? `<p class="methods"><strong>Methods.</strong> ${esc(parts.join(" "))}</p>` : "";
}

/** Named groups of strata with micro and macro views (C3). */
export function aggregatesTable(i: Intrinsic): string {
  const aggs = i.aggregates;
  if (!aggs || aggs.length === 0) return "";
  const f1 = (v: number | undefined): string => (v === undefined ? "—" : num(v));
  const microCell = (p: Prf | undefined): string => (p ? numCell(num(p.f1), `P ${num(p.precision)} · R ${num(p.recall)} · n ${int(p.n)}`) : numCell("—"));
  const body = aggs
    .map(
      (a) =>
        `<tr><th scope="row">${esc(a.name)}</th><td>${esc(a.strata.join(", "))}</td>${microCell(a.micro)}${numCell(f1(a.macro_page_f1))}${numCell(f1(a.macro_stratum_f1))}${numCell(a.ci95 ? ci(a.ci95) : "—")}</tr>`,
    )
    .join("");
  const table = `<table><thead><tr>${th("Aggregate")}${th("Strata")}${th("Micro F1", true)}${th("Macro F1, by page", true)}${th("Macro F1, by stratum", true)}${th("95% CI", true)}</tr></thead><tbody>${body}</tbody></table>`;
  return `<h3>Aggregates</h3>${noteLine("Micro pools every example of the member strata; macro averages the pages or the strata, so a large page does not dominate. The CI is as stored in the report.")}${tableWrap(table)}`;
}

/** Slices by dataset tag (logged_in, lang:pt, ...). */
export function byTagTable(i: Intrinsic): string {
  const entries = Object.entries(i.by_tag ?? {});
  if (entries.length === 0) return "";
  const body = entries
    .map(([k, p]) => `<tr><th scope="row">${esc(k)}</th>${numCell(int(p.n))}${numCell(int(p.n_groups))}${numCell(num(p.precision))}${numCell(num(p.recall))}${numCell(num(p.f1))}</tr>`)
    .join("");
  return `<h3>By tag</h3>${noteLine("Slices by the dataset's group tags. A page can carry several tags, so the slices overlap.")}${tableWrap(`<table><thead><tr>${th("Tag")}${th("n", true)}${th("Groups", true)}${th("Precision", true)}${th("Recall", true)}${th("F1", true)}</tr></thead><tbody>${body}</tbody></table>`)}`;
}

/** Model-minus-baseline per stratum with the report's group-bootstrap CI, one panel per metric. */
export function comparisonBlock(i: Intrinsic): string {
  if (i.comparison.length === 0) return absent("No model-versus-baseline comparison in this report.");
  const baselines = Object.keys(i.baselines);
  const series: Series[] = seriesFor("", baselines).slice(1).map((s) => ({ ...s, cls: "s0" }));
  // Chart rows are short (the aggregation is a table column); it is appended only to tell apart two rows of one stratum.
  const SHORT: Record<string, string> = { micro: "micro", macro_page: "page", macro_stratum: "stratum" };
  const rowLabel = (e: Cmp, all: Cmp[]): string =>
    new Set(all.filter((x) => x.stratum === e.stratum).map((x) => x.aggregation ?? "")).size > 1 ? `${e.stratum} · ${e.aggregation ? SHORT[e.aggregation] : "n/a"}` : e.stratum;
  const metrics = [...new Set(i.comparison.map((e) => e.metric))];
  const panels = metrics.map((metric) => {
    const mine = i.comparison.filter((e) => e.metric === metric);
    const label = METRIC_LABEL[metric] ?? metric;
    const rows: DwRow[] = [...new Set(mine.map((e) => rowLabel(e, mine)))].map((l) => ({
      label: l,
      points: baselines.map((b) => {
        const e = mine.find((x) => rowLabel(x, mine) === l && x.baseline === b);
        return e ? { value: e.delta, ci: e.ci95 } : undefined;
      }),
    }));
    const all = mine.flatMap((e) => [e.ci95[0], e.ci95[1], e.delta]);
    const axis = niceAxis(Math.min(...all), Math.max(...all));
    const svg = dotWhisker({
      id: metric === "f1" ? "chart-delta" : `chart-delta-${metric}`,
      title: `${label} difference, model minus baseline, by stratum`,
      desc: `Dot is the ${label} difference; the whisker is its 95% group-bootstrap confidence interval; the dashed line marks zero.`,
      rows,
      series,
      domain: axis.domain,
      ticks: axis.ticks,
      axisLabel: `Δ${label}: model − baseline, 95% CI`,
      decimals: 3,
      zeroLine: true,
    });
    return `<h3>Model versus each baseline (${esc(label)})</h3><div class="panel">${svg}</div>`;
  });
  const verdict = (e: Cmp): string => (e.ci95[0] > 0 ? "Yes: model better" : e.ci95[1] < 0 ? "Yes: baseline better" : "No");
  const withAgg = i.comparison.some((e) => e.aggregation);
  const body = i.comparison
    .map(
      (e) =>
        `<tr><th scope="row">${esc(e.stratum)}</th><td>${esc(METRIC_LABEL[e.metric] ?? e.metric)}</td>${withAgg ? `<td>${esc(e.aggregation ? (AGG_LABEL[e.aggregation] ?? e.aggregation) : "—")}</td>` : ""}<td>${esc(e.baseline)}</td>${numCell(num(e.model))}${numCell(num(e.baseline_value))}${numCell(signed(e.delta))}${numCell(ci(e.ci95))}${numCell(int(e.n_groups))}<td>${verdict(e)}</td></tr>`,
    )
    .join("");
  const table = `<table><thead><tr>${th("Stratum")}${th("Metric")}${withAgg ? th("Aggregation") : ""}${th("Baseline")}${th("Model", true)}${th("Baseline value", true)}${th("Δ", true)}${th("95% CI of Δ", true)}${th("Groups", true)}${th("CI excludes 0")}</tr></thead><tbody>${body}</tbody></table>`;
  return `${legend(series)}${noteLine("Right of the dashed line the model is better. Whiskers are 95% group-bootstrap CIs.")}${panels.join("")}${tableWrap(table)}`;
}
