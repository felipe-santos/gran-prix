// plan-v0.md: the readable summary of plan-v0.json. Pure string building.

const usd = (n) => `$${n.toFixed(2)}`;
const int = (n) => Math.round(n).toLocaleString("en-US");
const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

const TASK_ORDER = ["prompt-dev", "audit", "retest", "train-sample", "test-review"];

export function renderPlanMarkdown(plan) {
  const L = [];
  const cats = plan.categories;
  L.push("# Labeling plan v0 (dom-v0, E2.5/E2.6): dry run, no paid call", "");
  L.push(
    `Corpus ${plan.inputs.corpus} (${plan.inputs.pages} pages, lock \`${plan.inputs.lock_sha256.slice(0, 19)}...\`), split \`${plan.inputs.split.salt}\` ranges 55/70/100, guide \`${plan.inputs.guide_sha256.slice(0, 12)}...\`, pipeline \`${plan.inputs.pipeline_sha256.slice(0, 19)}...\`.`,
    `Selection by hash: \`${plan.selection_formula}\`.`,
    "",
  );

  L.push("## Selections", "");
  L.push(table(["task", "mode", ...cats, "total", "split", "human task"], TASK_ORDER.map((t) => {
    const s = plan.selections[t];
    return [t, s.mode, ...cats.map((c) => String(s.by_category[c] ?? 0)), String(s.pages.length), Object.entries(s.by_split).map(([k, v]) => `${k} ${v}`).join(", "), s.human_task];
  })));
  L.push("", "Split of the corpus (pages): " + plan.corpus_by_split.map((r) => `${r.split} ${r.total}`).join(", ") + ".", "");
  L.push(table(["category", "train", "val", "test"], cats.map((c) => [c, ...["train", "val", "test"].map((s) => String(plan.corpus_split_by_category[c]?.[s] ?? 0))])), "");

  L.push("## What goes to the LLM", "");
  L.push(table(["phase", "pages", "routing", "eligible units", "units sent", "blocks of context", "calls (chunks)", "input tokens (cl100k)", "output tokens"], plan.phases.map((p) => [
    p.name, String(p.pages), p.routing, int(p.eligible_units), int(p.units_sent), int(p.context_blocks), int(p.chunks), int(p.user_tokens), int(p.out_tokens),
  ])));
  L.push("", `System prompt (guide sections 1-4 + output instructions): ${int(plan.system_prompt.tokens_cl100k)} tokens (cl100k), ${int(plan.system_prompt.chars)} characters, sha256 \`${plan.system_prompt.prompt_sha256.slice(0, 19)}...\`. It is sent as a cached prefix on every call.`);
  L.push("", `Routing by disagreement (train + val, pages not in prompt-dev): ${plan.routing_dev.pages} pages, ${int(plan.routing_dev.units_sent)} of ${int(plan.routing_dev.eligible_units)} units sent (${(100 * plan.routing_dev.units_sent / plan.routing_dev.eligible_units).toFixed(1)}%); whole page: ${plan.routing_dev.whole_page_pages} pages (${Object.entries(plan.routing_dev.whole_page_reasons).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}); by reason: ${Object.entries(plan.routing_dev.by_reason).map(([k, v]) => `${k} ${int(v)}`).join(", ")}.`, "");

  L.push("## Cost per model (USD, standard prices, with cache)", "");
  L.push(`Cap ${usd(plan.cost.cap_usd)} (protocol 5.6 recommends raising D6 to this value; it also has to cover the QA of E3.4).`, "");
  for (const m of plan.cost.models) {
    L.push(`### ${m.model}: ${m.configuration}`, "");
    L.push(table(["phase", "calls (exp.)", "expected", "upper"], [
      ...m.phases.map((p) => [`${p.phase}${p.iterations > 1 ? ` (x${p.iterations})` : ""}`, int(p.expected.calls), usd(p.expected.usd), usd(p.upper.usd)]),
      ["**total**", int(m.totals.expected.calls), `**${usd(m.totals.expected.usd)}**`, `**${usd(m.totals.upper.usd)}**`],
    ]));
    L.push("", `Within the cap: expected ${m.within_cap.expected ? "yes" : "NO"}, upper ${m.within_cap.upper ? "yes" : "NO"}. Left for the QA at the cap: ${usd(plan.cost.cap_usd - m.totals.expected.usd)} (expected) / ${usd(plan.cost.cap_usd - m.totals.upper.usd)} (upper). ${m.thinking_note} If the Batch API were used (not implemented): ${usd(m.batch_info.expected_usd_if_batched)} expected.${m.haiku_tier_ok === null ? "" : ` Largest prompt, upper scenario: ${int(m.max_prompt_tokens_upper)} tokens (${m.haiku_tier_ok ? "inside" : "OUTSIDE"} the 100k tier of the Haiku price).`}`, "");
  }

  L.push("## How the estimate is made, and what it does not know", "");
  for (const a of plan.cost.assumptions) L.push(`- ${a}`);
  L.push("", "## Interpretations", "");
  for (const a of plan.interpretations) L.push(`- ${a}`);
  L.push("");
  return L.join("\n");
}
