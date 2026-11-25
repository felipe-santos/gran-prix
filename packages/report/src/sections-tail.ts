import { dotWhisker, niceAxis, type DwRow, type Series } from "./charts.js";
import { ci, esc, int, num, signed } from "./format.js";
import { bootstrapText } from "./sections-methods.js";
import { codeId, kv, noteLine, numCell, section, tableWrap, th, type Ctx, type Section } from "./ui.js";

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
  const withEvidence = arms.some(([, a]) => a.evidence_retention);
  const evidence = (a: (typeof arms)[number][1]): string => {
    const e = a.evidence_retention;
    return withEvidence ? (e ? numCell(num(e.mean), e.ci95 ? ci(e.ci95) : undefined) : numCell("—")) : "";
  };
  const armRows = arms
    .map(([k, a]) => `<tr><th scope="row">${esc(k)}</th>${numCell(int(a.n))}${numCell(num(a.score_mean), ci(a.score_ci95))}${evidence(a)}${numCell(int(a.tokens_in_mean))}${numCell(num(a.cost_usd, 2))}</tr>`)
    .join("");
  const armTable = `<table><thead><tr>${th("Arm")}${th("n", true)}${th("Score (95% CI)", true)}${withEvidence ? th("Evidence retained (95% CI)", true) : ""}${th("Mean input tokens", true)}${th("Cost (USD)", true)}</tr></thead><tbody>${armRows}</tbody></table>`;
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
    ["Judge", `${esc(judge.kind)}${judge.model ? ` (<code>${esc(judge.model)}</code>)` : ""}${judge.human_agreement !== undefined ? `, agreement with human raters ${num(judge.human_agreement)}` : ""}`],
  ]);
  const methods = d.bootstrap ? noteLine(`CIs: ${bootstrapText(d.bootstrap)}.`) : "";
  return section("downstream", "Downstream QA", `${info}${methods}<h3>Score by arm</h3><div class="panel">${armSvg}</div>${tableWrap(armTable)}${paired}`);
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
