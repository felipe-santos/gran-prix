import type { Gate } from "@gran-prix/contracts";
import { ci, comparatorSymbol, esc, int, num, plural, shortId, unitCi, unitPair, unitValue } from "./format.js";
import { gateView, type GateView } from "./resolve.js";
import { absent, codeId, isV10, kv, section, statusBadge, type Ctx, type Section } from "./ui.js";

/** An id shortened for reading, with the full value in the tooltip (and in the Provenance section). */
const shortCode = (id: string): string => `<code title="${esc(id)}">${esc(shortId(id))}</code>`;

function systemText(c: Ctx): string | undefined {
  const s = c.x.system;
  if (!s) return undefined;
  const label = [s.family, [s.name, s.version].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
  return `<strong>${esc(s.kind)}</strong>${label ? ` · ${esc(label)}` : ""}`;
}

/** (1) Title and a compact identity block: names and short ids only. Hashes live in Provenance. */
export function headerHtml(c: Ctx, navItems: Section[]): string {
  const { r, x } = c;
  const split = typeof r.split === "string" ? r.split : `k-fold ${r.split.kfold.fold + 1} of ${r.split.kfold.k}`;
  const named = (n: string | undefined, id: string): string => (n ? `<strong>${esc(n)}</strong> ${shortCode(id)}` : shortCode(id));
  const system = systemText(c);
  const toc = navItems.length
    ? `<nav aria-label="Sections"><ul class="toc">${navItems.map((s) => `<li><a href="#${esc(s.id)}">${esc(s.title)}</a></li>`).join("")}</ul></nav>`
    : "";
  return `<header class="top"><p class="eyebrow">Gran-Prix · evaluation report</p>
<h1>${x.names?.model ? `${esc(x.names.model)} on ${esc(x.names.dataset ?? "dataset")}` : "Evaluation report"}</h1>
<p class="sub">${esc(r.mode)} evaluation · split ${esc(split)} · operating threshold ${num(r.threshold, 2)}</p>
<dl class="kv ident">${[
    ...(system ? [["System", system]] : []),
    ["Model", named(x.names?.model, r.model_id)],
    ["Dataset", named(x.names?.dataset, r.dataset_id)],
    ["Report", shortCode(r.report_id)],
  ]
    .map(([k, v]) => `<dt>${esc(k as string)}</dt><dd>${v}</dd>`)
    .join("")}</dl>
${toc}</header>`;
}

/** Index of the CI bound that decides a `use_ci_lower` gate: the one facing the threshold. */
const decidingBound = (g: Gate): 0 | 1 => (g.comparator === "<=" || g.comparator === "<" ? 1 : 0);

function ciLine(v: GateView): string {
  const g = v.gate;
  if (!v.ci95) return "";
  const signedDiff = g.baseline !== undefined;
  const unit = g.unit;
  if (!g.use_ci_lower) {
    return `<p class="gc">95% CI <span class="ci-int">${esc(unit ? unitCi(v.ci95, unit, { signed: signedDiff }) : ci(v.ci95))}</span> <span class="muted">(the point estimate decides)</span></p>`;
  }
  const at = decidingBound(g);
  const fmt = (x: number): string => unitValue(x, unit, { signed: signedDiff });
  const lo = fmt(v.ci95[0]);
  const hi = fmt(v.ci95[1]);
  const mark = (s: string, hit: boolean): string => (hit ? `<mark class="decider" title="the bound that decided this gate">${esc(s)}</mark>` : esc(s));
  return `<p class="gc">95% CI <span class="ci-int">[${mark(lo, at === 0)}, ${mark(hi, at === 1)}]</span> <span class="muted">decided on the ${at === 0 ? "lower" : "upper"} bound</span></p>`;
}

function gateCard(v: GateView): string {
  const g = v.gate;
  const signedDiff = g.baseline !== undefined;
  const title = v.name ? `<strong>${esc(v.name)}</strong><code>${esc(g.id)}</code>` : `<strong><code>${esc(g.id)}</code></strong>`;
  let decision: string;
  if (g.comparator !== undefined && g.threshold !== undefined) {
    const [a, b] = unitPair(g.value, g.threshold, g.unit, { signed: signedDiff });
    const what = g.use_ci_lower ? `CI ${decidingBound(g) === 0 ? "lower" : "upper"} bound` : "Observed";
    decision = `<p class="gv"><span class="muted">${what}</span> <b class="obs">${esc(a)}</b> <span class="cmp">${esc(comparatorSymbol(g.comparator))}</span> <span class="thr">${esc(b)}</span></p>`;
    if (g.use_ci_lower && g.observed !== undefined) {
      decision += `<p class="gc">Point estimate <b>${esc(unitValue(g.observed, g.unit, { signed: signedDiff }))}</b></p>`;
    }
  } else {
    const shown = g.unit ? unitValue(g.value, g.unit, { signed: signedDiff }) : num(g.value);
    decision = `<p class="gv"><span class="muted">Observed</span> <b class="obs">${esc(shown)}</b>${v.thresholdText ? ` <span class="muted">threshold</span> <span class="thr">${esc(v.thresholdText)}</span>` : ""}</p>`;
  }
  const meta = [
    g.stratum && g.stratum !== "overall" ? `on ${g.stratum}` : "",
    g.metric ? `metric ${g.metric}` : "",
    g.baseline ? `vs ${g.baseline}` : "",
    g.aggregation ? g.aggregation.replace("_", " ") : "",
  ].filter(Boolean);
  return `<li class="gate ${g.passed ? "pass" : "fail"}"><div class="gh"><div class="gt">${title}</div>${statusBadge(g.passed)}</div>${decision}${ciLine(v)}${meta.length ? `<p class="gm">${esc(meta.join(" · "))}</p>` : ""}<p class="gr"><code>${esc(g.rule)}</code></p></li>`;
}

/** (2) Pre-registered go/no-go gates, first thing after the identity block. Omitted when the report has none. */
export function gatesSection(c: Ctx): Section | undefined {
  const gates = c.r.gates;
  if (!gates || gates.length === 0) return undefined;
  const failed = gates.filter((g) => !g.passed).length;
  const banner =
    failed === 0
      ? `<div class="banner pass" role="status">${statusBadge(true)} All ${plural(gates.length, "gate")} passed</div>`
      : `<div class="banner fail" role="status">${statusBadge(false)} ${failed} of ${plural(gates.length, "gate")} failed</div>`;
  const views = gates.map((g) => gateView(g, c.x.gate_details));
  const list = `<ul class="gates">${views.map((v) => gateCard(v)).join("")}</ul>`;
  const anyCi = views.some((v) => v.ci95);
  const note = anyCi || !isV10(c) ? "" : absent("Confidence intervals for gate values are not in this report (EvalReport v1.0.0 stores the observed value only).");
  return section("gates", "Gates", `${banner}${list}${note}`);
}

/** Last section, collapsed: where the report came from. Full hashes live here, not at the top. */
export function provenanceSection(c: Ctx): Section {
  const { r } = c;
  const p = r.provenance;
  const tv = p.tool_versions;
  const rows: [string, string][] = [
    ["Report id", codeId(r.report_id)],
    ["Model id", codeId(r.model_id)],
    ["Dataset id", codeId(r.dataset_id)],
    ["Format", `<code>${esc(r.format)}</code> v${esc(r.format_version)}`],
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
  return section(
    "provenance",
    "Provenance",
    `<details class="prov"><summary>Run, inputs and tool hashes (${int(rows.length)} entries)</summary>${kv(rows)}</details>`,
  );
}
