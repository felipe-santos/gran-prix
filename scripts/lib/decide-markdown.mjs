// decision.json -> a readable decision.md: the verdict, every step of section 11 with the value that decided it, every
// gate with its observed value and threshold, the categories, and the flags. Pure formatting: no rule lives here.

const f = (v, d = 4) => (typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(d) : "NaN") : String(v));
const yn = (b) => (b ? "PASS" : "FAIL");
const row = (...cells) => `| ${cells.join(" | ")} |`;

export function renderMarkdown(d) {
  const g = d.gates;
  const out = [];
  out.push(`# Decision of the DOM experiment: ${d.verdict}`, "");
  out.push(`Rule fired: step ${d.rule_fired} of section 11. Protocol: ${d.protocol}`);
  if (d.provisional_if_no_extension) out.push("", `Provisional result without the extension: **${d.provisional_if_no_extension}**. The inconclusive zone calls for the single pre-authorized extension before this is final.`);
  if (d.pivot_reason?.length) out.push("", `PIVOT because: ${d.pivot_reason.join("; ")}.`);
  out.push("", "## Steps, in the fixed order", "", row("#", "step", "rule", "fires"), row("-", "-", "-", "-"));
  for (const s of d.steps) out.push(row(s.n, s.name, s.rule, s.fires ? "**yes**" : "no"));
  out.push("", "What each step looked at:", "");
  for (const s of d.steps.filter((x) => x.n < 5)) out.push(`- step ${s.n} (${s.name}): \`${JSON.stringify(s.observed)}\``);

  out.push("", "## Gates", "", row("gate", "observed", "threshold", "result"), row("-", "-", "-", "-"));
  out.push(row("G0 (dev OOF, hard): GBDT - best individual (" + g.G0.best_individual + ")", `${f(g.G0.gbdt)} - ${f(g.G0.best_individual_f1)} = ${f(g.G0.delta)}`, `>= ${g.G0.threshold}`, yn(g.G0.passed)));
  out.push(row(`G1a (test, hard): MLP - ${g.G1a.baseline}, mean of ${g.G1a.per_seed.length} seeds`, `delta ${f(g.G1a.delta)}, CI lower ${f(g.G1a.ci_lower)} (min over seeds ${f(g.G1a.ci_lower_min_over_seeds)})`, `delta >= ${g.G1a.threshold} and CI lower > ${g.G1a.ci_lower_gt}`, yn(g.G1a.passed)));
  out.push(row(`G1b (test, hard): MLP - ${g.G1b.baseline}`, f(g.G1b.delta), `>= ${g.G1b.threshold}`, yn(g.G1b.passed)));
  out.push(row(`G2 (articles): MLP - ${g.G2.baseline}`, `test ${f(g.G2.test_delta)}; pooled ${g.G2.pooled_n_pages} pages, one-sided ${g.G2.pooled_level} lower bound ${f(g.G2.pooled_lower)}`, `test >= ${g.G2.test_threshold}; pooled >= ${g.G2.pooled_threshold}`, yn(g.G2.passed)));
  for (const [r, v] of Object.entries(g.G3.respondents)) out.push(row(`G3 (QA, ${r}): pruned_model - full_page`, `delta ${f(v.delta_pp, 2)} pp, CI lower ${f(v.ci_lower_pp, 2)} pp, retention ${f(v.retention)}`, `CI lower >= ${g.G3.threshold_pp} pp and retention >= ${g.G3.retention_min}`, yn(v.passed)));
  out.push(row("G4 (test): median token reduction", `D1 ${f(g.G4.d1, 2)}x, D2 ${f(g.G4.d2, 2)}x`, `D1 >= ${g.G4.d1_min}x and D2 >= ${g.G4.d2_min}x`, yn(g.G4.passed)));
  out.push(row("G5 (runtime)", `p95 ${f(g.G5.p95_ms, 1)} ms, model ${g.G5.model_bytes} bytes`, `p95 <= ${g.G5.thresholds.p95_ms_max} ms and model <= ${g.G5.thresholds.model_bytes_max} bytes`, yn(g.G5.passed)));
  out.push(row("G6 (logged in)", `${Object.entries(g.G6.competitors).map(([k, v]) => `vs ${k} ${f(v.delta)} (${v.n_pages} pages)`).join("; ")}; inaccessible share ${f(g.G6.inaccessible_share, 3)}`, `delta >= ${g.G6.thresholds.min_delta_vs_competitor} and share >= ${g.G6.thresholds.inaccessible_share_min}`, yn(g.G6.passed)));
  for (const [r, v] of Object.entries(g.G3_router.respondents)) out.push(row(`G3 of the router (QA, ${r})`, `delta ${f(v.delta_pp, 2)} pp, CI lower ${f(v.ci_lower_pp, 2)} pp, retention ${f(v.retention)}`, "as G3", yn(v.passed)));
  out.push(row("G4 of the router", `D1 ${f(g.G4_router.d1, 2)}x, D2 ${f(g.G4_router.d2, 2)}x`, "as G4", yn(g.G4_router.passed)));

  out.push("", "## Hard categories: eligibility for the conditional GO", "", row("category", "baseline (dev)", "delta", "CI lower (80%)", "QA delta pp (R1)", "retention (R1)", "D2 median", "eligible"), row("-", "-", "-", "-", "-", "-", "-", "-"));
  for (const [c, e] of Object.entries(d.categories.detail)) {
    const k = e.checks;
    out.push(row(c, e.baseline, `${f(k.delta.value)} (>= ${k.delta.threshold})`, `${f(k.ci_lower.value)} (> ${k.ci_lower.threshold})`, `${f(k.qa_delta_pp.value, 2)} (>= ${k.qa_delta_pp.threshold})`, `${f(k.retention.value)} (>= ${k.retention.threshold})`, `${f(k.d2_median.value, 2)} (>= ${k.d2_median.threshold})`, e.eligible ? "**yes**" : "no"));
  }
  out.push("", `Eligible: ${d.categories.eligible.length ? d.categories.eligible.join(", ") : "none"}. G3 over the eligible categories: ${yn(g.G3_on_eligible.passed)}. ${g.G3_on_eligible.approximation}.`);
  const flagged = Object.entries(g.G3.flagged_categories).filter(([, v]) => v.length > 0);
  if (flagged.length) out.push("", `Categories whose QA delta is under the flag threshold: ${flagged.map(([r, v]) => `${r}: ${v.join(", ")}`).join("; ")}.`);

  out.push("", "## Flags", "");
  const fl = d.flags;
  out.push(`- Inconclusive zone: ${fl.inconclusive_zone.raised ? "**RAISED**" : "no"} (${fl.inconclusive_zone.rule}). ${fl.inconclusive_zone.raised ? `Action: ${fl.inconclusive_zone.action}. Extension already done: ${fl.inconclusive_zone.extension_done}.` : ""}`);
  out.push(`- GBDT - MLP: ${f(fl.gbdt_minus_mlp.value)} (investigate above ${fl.gbdt_minus_mlp.threshold}): ${fl.gbdt_minus_mlp.investigate ? "**INVESTIGATE** capacity/features" : "no"}. ${fl.gbdt_minus_mlp.note}.`);
  out.push(`- Rescue arm (tau at recall >= ${fl.rescue_arm.recall_target}): ${fl.rescue_arm.allowed ? "**ALLOWED**, once" : "not allowed or not needed"} (already done: ${fl.rescue_arm.rescue_done}).`);
  out.push(`- D2 below the "ML is not the source of the reduction" line: ${fl.d2_ml_is_not_the_source ? "**yes**" : "no"}.`);
  out.push(`- G5 failed, blocks E4 until the model is optimized: ${fl.g5_blocks_e4_until_optimized ? "**yes**" : "no"}. G6 failed, the logged-in differentiator is off the table: ${fl.g6_forbids_logged_in_differentiator ? "**yes**" : "no"}.`);

  out.push("", "## Systems and inputs", "", `Best individual baseline in dev (hard): ${d.systems.best_individual_in_dev}. Best baseline per category in dev: ${Object.entries(d.systems.best_by_stratum_in_dev).map(([c, v]) => `${c}: ${v.id} (${f(v.f1)}, ${v.n_pages} pages)`).join("; ")}.`);
  out.push("", `MLP statistics are the mean over seeds ${d.seeds.list.join(", ")}; CI bounds are ${d.seeds.aggregation.ci_lower.replace(/_/g, " ")} (${d.seeds.aggregation.note ?? ""}).`);
  for (const [k, v] of Object.entries(d.inputs)) out.push("", `${k}: \`${typeof v === "string" ? v : JSON.stringify(v)}\``);
  return `${out.join("\n")}\n`;
}
