import { ci, esc, factor, int, num, trimmed, unitValue } from "./format.js";
import type { DenominatorView } from "./resolve.js";
import { absent, kv, noteLine, notInReport, numCell, section, tableWrap, th, type Ctx, type Section } from "./ui.js";

/** The fields of a denominator row, whichever source (report or sidecar) they came from. */
interface Row {
  label: string;
  full: number;
  kept: number;
  pages?: number;
  medianRatio?: number;
  iqrRatio?: readonly [number, number];
  medianReduction?: number;
  iqrReduction?: readonly [number, number];
  pooledRatio?: number;
}

const rowOf = (label: string, d: DenominatorView): Row => {
  const r: Row = { label, full: d.full_tokens, kept: d.kept_tokens };
  if (d.n_pages !== undefined) r.pages = d.n_pages;
  if (d.median_ratio !== undefined) r.medianRatio = d.median_ratio;
  if (d.iqr_ratio !== undefined) r.iqrRatio = d.iqr_ratio;
  if (d.median_reduction !== undefined) r.medianReduction = d.median_reduction;
  if (d.iqr_reduction !== undefined) r.iqrReduction = d.iqr_reduction;
  if (d.pooled_ratio !== undefined) r.pooledRatio = d.pooled_ratio;
  return r;
};

/** Median reduction (full/kept): the report's own value, or derived from the median kept/full of a sidecar. */
const medianReduction = (r: Row): number | undefined => r.medianReduction ?? (r.medianRatio !== undefined && r.medianRatio > 0 ? 1 / r.medianRatio : undefined);
const iqrReduction = (r: Row): readonly [number, number] | undefined =>
  r.iqrReduction ?? (r.iqrRatio && r.iqrRatio[1] > 0 && r.iqrRatio[0] > 0 ? [1 / r.iqrRatio[1], 1 / r.iqrRatio[0]] : undefined);

function tableRow(r: Row): string {
  const pooled = r.pooledRatio ?? (r.full > 0 ? r.kept / r.full : 0);
  const med = medianReduction(r);
  const iqr = iqrReduction(r);
  const lines =
    med === undefined
      ? "—"
      : `<b>${factor(med)}</b>${iqr ? `<span class="ci">IQR ${factor(iqr[0])} to ${factor(iqr[1])}</span>` : ""}${
          r.medianRatio !== undefined ? `<span class="ci">kept/full ${num(r.medianRatio)}${r.iqrRatio ? ` (IQR ${esc(ci(r.iqrRatio))})` : ""}</span>` : ""
        }`;
  return `<tr><th scope="row">${r.label}</th>${numCell(r.pages === undefined ? "—" : int(r.pages))}${numCell(int(r.full))}${numCell(int(r.kept))}<td class="n">${lines}</td>${numCell(num(pooled))}${numCell(pooled > 0 ? factor(1 / pooled) : "n/a")}</tr>`;
}

function strataDetails(c: Ctx): string {
  const tr = c.x.token_reduction;
  const rows = (["d1", "d2"] as const).flatMap((k) =>
    Object.entries(tr?.[k]?.by_stratum ?? {}).map(([s, v]) => {
      const med = v.median_reduction ?? (v.median_ratio && v.median_ratio > 0 ? 1 / v.median_ratio : undefined);
      return `<tr><th scope="row">${k.toUpperCase()}</th><td>${esc(s)}</td>${numCell(v.n_pages === undefined ? "—" : int(v.n_pages))}${numCell(v.median_ratio === undefined ? "—" : num(v.median_ratio))}${numCell(med === undefined ? "—" : factor(med))}</tr>`;
    }),
  );
  if (rows.length === 0) return "";
  return `<details><summary>By stratum (median over pages)</summary>${tableWrap(`<table><thead><tr>${th("Denominator")}${th("Stratum")}${th("Pages", true)}${th("Median kept/full", true)}${th("Median reduction", true)}</tr></thead><tbody>${rows.join("")}</tbody></table>`)}</details>`;
}

/** (6) Token reduction against both denominators (D1 raw HTML, D2 whole-page markdown). */
export function tokensSection(c: Ctx): Section | undefined {
  const stats = c.r.intrinsic?.token_stats;
  const tr = c.x.token_reduction;
  if (!stats && !tr?.d1 && !tr?.d2) return undefined;
  const rows: string[] = [];
  if (tr?.d1) rows.push(tableRow(rowOf("D1 · raw HTML (outerHTML)", tr.d1)));
  if (tr?.d2) rows.push(tableRow(rowOf("D2 · whole-page markdown", tr.d2)));
  // `token_stats` is the v1.0 single ratio; once the report carries D1/D2 it would only repeat one of them.
  if (stats && c.x.from.token_reduction !== "report") rows.push(tableRow(rowOf("Contract <code>token_stats</code> (denominator not stated)", { full_tokens: stats.full_tokens, kept_tokens: stats.kept_tokens })));
  const table = `<table><thead><tr>${th("Denominator")}${th("Pages", true)}${th("Full tokens", true)}${th("Kept tokens", true)}${th("Median reduction (IQR)", true)}${th("Pooled kept / full", true)}${th("Pooled reduction", true)}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
  const tokenizer = tr?.tokenizer ?? stats?.tokenizer;
  const missing = [!tr?.d1 ? "D1" : "", !tr?.d2 ? "D2" : ""].filter(Boolean);
  const gap = missing.length
    ? absent(`${notInReport(c, `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"}`, "carries a single unlabelled kept/full ratio")} Report both denominators before quoting a reduction factor.`)
    : "";
  const descriptions = [tr?.d1?.description ? `D1: ${tr.d1.description}` : "", tr?.d2?.description ? `D2: ${tr.d2.description}` : ""].filter(Boolean);
  const intro = `${tokenizer ? `Tokenizer: <code>${esc(tokenizer)}</code>. ` : ""}${tr?.converter ? `Markdown converter: <code>${esc(tr.converter)}</code>. ` : ""}Reduction = full tokens / kept tokens. The median is over pages (what gate G4 reads); the pooled figure is the sum over pages and is dominated by large pages.`;
  return section(
    "tokens",
    "Token reduction",
    `<p>${intro}</p>${tableWrap(table)}${descriptions.map((d) => noteLine(d)).join("")}${strataDetails(c)}${gap}`,
  );
}

/** G5: latency and size of the shipped model. Omitted when the report has no `runtime`. */
export function runtimeSection(c: Ctx): Section | undefined {
  const rt = c.r.intrinsic?.runtime;
  if (!rt) return undefined;
  const rows: [string, string][] = [
    ["p95 latency", `<strong>${esc(unitValue(rt.p95_ms, "ms"))}</strong>`],
    ...(rt.p50_ms !== undefined ? [["p50 latency", esc(unitValue(rt.p50_ms, "ms"))] as [string, string]] : []),
    ["Model size", esc(unitValue(rt.model_bytes, "bytes"))],
    ["Pages measured", esc(int(rt.n_pages))],
    ...(rt.page_elements ? [["Page size", `${esc(int(rt.page_elements[0]))} to ${esc(int(rt.page_elements[1]))} elements`] as [string, string]] : []),
    ...(rt.cpu_throttle !== undefined ? [["CPU throttle", `${esc(trimmed(rt.cpu_throttle, 1))}× slowdown`] as [string, string]] : []),
    ...(rt.repetitions !== undefined ? [["Repetitions", esc(int(rt.repetitions))] as [string, string]] : []),
    ...(rt.environment ? [["Environment", esc(rt.environment)] as [string, string]] : []),
  ];
  return section("runtime", "Runtime (G5)", kv(rows));
}
