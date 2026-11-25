import { ci, esc, int, num, plural } from "./format.js";
import { absent, codeId, kv, section, statusBadge, tableWrap, th, type Ctx, type Section } from "./ui.js";

/** (1) Identity of the model, dataset and run, and where the report came from. */
export function headerHtml(c: Ctx, navItems: Section[]): string {
  const { r, x } = c;
  const split = typeof r.split === "string" ? r.split : `k-fold ${r.split.kfold.fold + 1} of ${r.split.kfold.k}`;
  const nameOf = (n: string | undefined, id: string): string => (n ? `<strong>${esc(n)}</strong><br>${codeId(id)}` : codeId(id));
  const p = r.provenance;
  const tv = p.tool_versions;
  const prov: [string, string][] = [
    ["Run", `<code>${esc(p.produced_by.run_id)}</code> (stage <code>${esc(p.produced_by.stage_id)}</code>, kind <code>${esc(p.produced_by.kind)}</code>)`],
    ["Implementation", `<code>${esc(p.produced_by.impl)}</code>`],
    ["Params hash", codeId(p.produced_by.params_sha256)],
    ["Cache key", codeId(p.produced_by.cache_key)],
    ["Pipeline spec", codeId(p.pipeline_spec_id)],
    ...p.inputs.map((i): [string, string] => [`Input: ${i.port}`, codeId(i.artifact_id)]),
    ["gp CLI", `<code>${esc(tv.gp_cli)}</code>`],
    ["Node", `<code>${esc(tv.node)}</code>`],
    ...(tv.git_commit ? [["Git commit", `<code>${esc(tv.git_commit)}</code>${tv.git_dirty ? " (dirty tree)" : ""}`] as [string, string]] : []),
    ...(tv.wasm_sha256 ? [["WASM hash", codeId(tv.wasm_sha256)] as [string, string]] : []),
    ...(tv.extractor ? [["Extractor", `<code>${esc(tv.extractor.name)}@${esc(tv.extractor.version)}</code> ${codeId(tv.extractor.bundle_sha256)}`] as [string, string]] : []),
    ["Created at", `<code>${esc(p.created_at)}</code>`],
    ...(p.host ? [["Host", esc(p.host)] as [string, string]] : []),
    ["Duration", `${int(p.duration_ms)} ms`],
  ];
  const toc = navItems.length
    ? `<nav aria-label="Sections"><ul class="toc">${navItems.map((s) => `<li><a href="#${esc(s.id)}">${esc(s.title)}</a></li>`).join("")}</ul></nav>`
    : "";
  return `<header class="top"><p class="eyebrow">Gran-Prix · evaluation report</p>
<h1>${x.names?.model ? `${esc(x.names.model)} on ${esc(x.names.dataset ?? "dataset")}` : "Evaluation report"}</h1>
<p class="sub">${esc(r.mode)} evaluation · split ${esc(split)} · operating threshold ${num(r.threshold, 2)}</p>
${kv([
  ["Report id", codeId(r.report_id)],
  ["Model", nameOf(x.names?.model, r.model_id)],
  ["Dataset", nameOf(x.names?.dataset, r.dataset_id)],
  ["Created", `<code>${esc(p.created_at)}</code>`],
  ["Format", `<code>${esc(r.format)}</code> v${esc(r.format_version)}`],
])}
<details class="prov" open><summary>Provenance</summary>${kv(prov)}</details>
${toc}</header>`;
}

/** (2) Pre-registered go/no-go gates, with their observed values. Omitted when the report has none. */
export function gatesSection(c: Ctx): Section | undefined {
  const gates = c.r.gates;
  if (!gates || gates.length === 0) return undefined;
  const failed = gates.filter((g) => !g.passed).length;
  const banner =
    failed === 0
      ? `<div class="banner pass" role="status">${statusBadge(true)} All ${plural(gates.length, "gate")} passed</div>`
      : `<div class="banner fail" role="status">${statusBadge(false)} ${failed} of ${plural(gates.length, "gate")} failed</div>`;
  const rows = gates
    .map((g) => {
      const d = c.x.gate_details?.[g.id];
      const name = d?.name ? `<strong>${esc(d.name)}</strong><br><code>${esc(g.id)}</code>` : `<code>${esc(g.id)}</code>`;
      const observed = `${num(g.value)}${d?.ci95 ? `<span class="ci">95% CI ${esc(ci(d.ci95))}</span>` : ""}`;
      return `<tr><th scope="row">${name}</th><td>${d?.threshold ? `<strong>${esc(d.threshold)}</strong><br>` : ""}<code>${esc(g.rule)}</code></td><td class="n">${observed}</td><td>${statusBadge(g.passed)}</td></tr>`;
    })
    .join("");
  const hasCi = gates.some((g) => c.x.gate_details?.[g.id]?.ci95);
  const table = `<table><thead><tr>${th("Gate")}${th("Threshold / rule")}${th("Observed", true)}${th("Result")}</tr></thead><tbody>${rows}</tbody></table>`;
  const note = hasCi ? "" : absent("Confidence intervals for gate values are not in this report (EvalReport v1.0.0 stores the observed value only).");
  return section("gates", "Gates", `${banner}${tableWrap(table)}${note}`);
}
