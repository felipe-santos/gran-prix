import { dotWhisker, niceAxis, type DwRow, type Series } from "./charts.js";
import { ci, esc, int, num, signed, times } from "./format.js";
import { absent, codeId, kv, numCell, section, tableWrap, th, type Ctx, type Section } from "./ui.js";

/** (6) Token reduction against both denominators (D1 raw HTML, D2 whole-page markdown). */
export function tokensSection(c: Ctx): Section | undefined {
  const stats = c.r.intrinsic?.token_stats;
  const ex = c.x.token_reduction;
  if (!stats && !ex?.d1 && !ex?.d2) return undefined;
  const rows: string[] = [];
  const row = (label: string, full: number, kept: number, median?: number, iqr?: readonly [number, number]): string => {
    const ratio = full > 0 ? kept / full : 0;
    const med = median !== undefined ? `${times(median)}${iqr ? ` (IQR ${esc(ci(iqr, 3))} kept/full)` : ""}` : "—";
    return `<tr><th scope="row">${label}</th>${numCell(int(full))}${numCell(int(kept))}${numCell(num(ratio))}${numCell(times(ratio))}<td class="n">${med}</td></tr>`;
  };
  if (ex?.d1) rows.push(row("D1 · raw HTML (outerHTML)", ex.d1.full_tokens, ex.d1.kept_tokens, ex.d1.median_ratio, ex.d1.iqr_ratio));
  if (ex?.d2) rows.push(row("D2 · whole-page markdown", ex.d2.full_tokens, ex.d2.kept_tokens, ex.d2.median_ratio, ex.d2.iqr_ratio));
  if (stats) rows.push(row(`Contract <code>token_stats</code> (denominator not stated)`, stats.full_tokens, stats.kept_tokens));
  const table = `<table><thead><tr>${th("Denominator")}${th("Full tokens", true)}${th("Kept tokens", true)}${th("Kept / full", true)}${th("Reduction", true)}${th("Median reduction (IQR)", true)}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
  const tokenizer = ex?.tokenizer ?? stats?.tokenizer;
  const missing = [!ex?.d1 ? "D1" : "", !ex?.d2 ? "D2" : ""].filter(Boolean);
  const gap = missing.length
    ? absent(`${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not in this report: EvalReport v1.0.0 carries a single unlabelled kept/full ratio. Report both denominators before quoting a reduction factor.`)
    : "";
  return section(
    "tokens",
    "Token reduction",
    `${tokenizer ? `<p>Tokenizer: <code>${esc(tokenizer)}</code>. Reduction = full tokens / kept tokens; the sum over pages, unless a median is shown.</p>` : ""}${tableWrap(table)}${gap}`,
  );
}

function scoreAxis(values: number[]): ReturnType<typeof niceAxis> {
  return niceAxis(Math.min(...values), Math.max(...values));
}

/** Downstream QA arms and paired deltas, for `mode: downstream` reports. */
export function downstreamSection(c: Ctx): Section | undefined {
  const d = c.r.downstream;
  if (!d) return undefined;
  const arms = Object.entries(d.arms);
  const one: Series = { name: "Score", shape: "circle", cls: "s0" };
  const armAxis = scoreAxis(arms.flatMap(([, a]) => [a.score_ci95[0], a.score_ci95[1], a.score_mean]));
  const armSvg = dotWhisker({
    id: "chart-arms",
    title: "Downstream score by arm",
    desc: "Mean score of each arm with its 95% confidence interval.",
    rows: arms.map(([k, a]): DwRow => ({ label: k, points: [{ value: a.score_mean, ci: a.score_ci95 }] })),
    series: [one],
    domain: armAxis.domain,
    ticks: armAxis.ticks,
    axisLabel: "Mean score (95% CI)",
    decimals: 3,
  });
  const armRows = arms
    .map(([k, a]) => `<tr><th scope="row">${esc(k)}</th>${numCell(int(a.n))}${numCell(num(a.score_mean), ci(a.score_ci95))}${numCell(int(a.tokens_in_mean))}${numCell(num(a.cost_usd, 2))}</tr>`)
    .join("");
  const armTable = `<table><thead><tr>${th("Arm")}${th("n", true)}${th("Score (95% CI)", true)}${th("Mean input tokens", true)}${th("Cost (USD)", true)}</tr></thead><tbody>${armRows}</tbody></table>`;
  let paired = "";
  if (d.paired_deltas.length > 0) {
    const all = d.paired_deltas.flatMap((p) => [p.ci95[0], p.ci95[1], p.mean_delta]);
    const axis = niceAxis(Math.min(...all), Math.max(...all));
    const svg = dotWhisker({
      id: "chart-paired",
      title: "Paired score differences",
      desc: "Mean paired difference between two arms with its 95% confidence interval; the dashed line marks zero.",
      rows: d.paired_deltas.map((p): DwRow => ({ label: `${p.a} − ${p.b}`, points: [{ value: p.mean_delta, ci: p.ci95 }] })),
      series: [one],
      domain: axis.domain,
      ticks: axis.ticks,
      axisLabel: "Paired difference in score (95% CI)",
      decimals: 3,
      zeroLine: true,
    });
    const rows = d.paired_deltas
      .map((p) => `<tr><th scope="row">${esc(p.a)} − ${esc(p.b)}</th>${numCell(signed(p.mean_delta))}${numCell(ci(p.ci95))}${numCell(p.p_value === undefined ? "—" : num(p.p_value))}<td>${p.ci95[0] > 0 || p.ci95[1] < 0 ? "Yes" : "No"}</td></tr>`)
      .join("");
    paired = `<h3>Paired differences</h3><div class="panel">${svg}</div>${tableWrap(`<table><thead><tr>${th("Pair (a − b)")}${th("Mean difference", true)}${th("95% CI", true)}${th("p-value", true)}${th("CI excludes 0")}</tr></thead><tbody>${rows}</tbody></table>`)}`;
  }
  const judge = d.judge;
  const info = kv([
    ["Task set", codeId(d.task_set_id)],
    ["Answering model", `<code>${esc(d.llm.model)}</code>`],
    ["Judge", `${esc(judge.kind)}${judge.model ? ` (<code>${esc(judge.model)}</code>)` : ""}`],
  ]);
  return section("downstream", "Downstream QA", `${info}<h3>Score by arm</h3><div class="panel">${armSvg}</div>${tableWrap(armTable)}${paired}`);
}

/** (7) Notes and threats to validity. Omitted when there are none. */
export function notesSection(c: Ctx): Section | undefined {
  const notes = c.x.notes;
  if (!notes || notes.length === 0) return undefined;
  const items = notes
    .map((n) => `<li class="${n.kind}"><span class="kind">${n.kind === "threat" ? "Threat to validity" : "Note"}</span>${esc(n.text)}</li>`)
    .join("");
  return section("notes", "Notes and threats", `<ul class="notes">${items}</ul>`);
}
