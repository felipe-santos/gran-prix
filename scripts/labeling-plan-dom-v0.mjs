#!/usr/bin/env node
/**
 * Labeling plan of the DOM experiment (protocol section 5.1), mechanical and by hash. A DRY RUN end to end: it runs
 * `pipelines/dom-v0-labeling.json` (extract, Readability, Trafilatura recall, Defuddle, label.llm with dry_run), reads the
 * routing it computed, counts the tokens of the real prompt, and writes
 *
 *   <out>/plan-v0.json              per page: split, category, roles, routing (units sent, blocks, tokens), human task
 *   <out>/plan-v0.md                the readable summary, with the cost per model and phase against the cap
 *   <out>/queues/<task>.json        the Studio queues (contract gran-prix.label-queue 1.0.0)
 *
 *   node scripts/labeling-plan-dom-v0.mjs [--root <repo root with data/ and IDEIAS/>] [--out data/labeling]
 *        [--data-dir <gp data dir>] [--cap-usd 25] [--audit-completed-at <ISO date>]
 *
 * Nothing is paid and no key is read: ANTHROPIC_API_KEY is removed from the environment before anything runs, the ledger cap
 * is 0, and the script refuses a pipeline whose `dry_run` var is not true. Needs `pnpm -r build` and the Python sidecar of
 * Trafilatura (GP_BASELINES_PYLIBS, see tools/baselines/README.md). Deterministic: the same inputs give the same files.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_SIZES, ORDER_PREFIX, PURPOSES, countsBy, orderHash, selectPages } from "./lib/labeling-select.mjs";
import { SCENARIOS, TOKEN_UNCERTAINTY, modelCost } from "./lib/labeling-cost.mjs";
import { renderPlanMarkdown } from "./lib/labeling-render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(resolve(HERE, rel)).href);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const QUEUE_FORMAT = "gran-prix.label-queue";
export const PLAN_FORMAT = "gran-prix.labeling-plan";
export const TASKS = {
  "prompt-dev": { mode: "blind", human_task: "label from scratch, blind to the LLM and the extractors (5.1.2)" },
  audit: { mode: "blind", human_task: "label from scratch, blind to the LLM and the extractors (5.1.3); the LLM and the 3 extractors run on every node" },
  retest: { mode: "blind", human_task: "label again, blind to the first label, 7 days or more after the audit (5.4)" },
  "train-sample": { mode: "review", human_task: "full review of the routed labels (5.1.7)" },
  "test-review": { mode: "review", human_task: "review 100% of the nodes of the LLM draft (5.1.6)" },
};

/** The Studio queue of one task. `plan_sha256` ties it to the plan file it came from. */
export function buildQueue(task, pages, planSha256, notBefore = null) {
  return {
    format: QUEUE_FORMAT,
    format_version: "1.0.0",
    task,
    mode: TASKS[task].mode,
    plan_sha256: planSha256,
    not_before: notBefore,
    pages: pages.map((p) => ({ snapshot_id: p.snapshot_id, url: p.url, category: p.category, split: p.split })),
  };
}

/** `YYYY-MM-DD` of `auditDone` + 7 days (UTC), or null. */
export function retestNotBefore(auditDone) {
  if (!auditDone) return null;
  const d = new Date(auditDone);
  if (Number.isNaN(d.getTime())) throw new Error(`--audit-completed-at is not a date: ${auditDone}`);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

/** Token statistics of one page for a routed set: the chunks as the labeler would send them (cl100k proxy). */
export function pageTokens({ snapshot, units, routed, lib, cfg }) {
  const blocks = lib.buildBlocks(snapshot, units, cfg.block);
  const chunks = lib.chunkBlocks(blocks, new Set(routed), cfg.chunk_blocks, cfg.ctx_blocks);
  const header = { title: snapshot.page.title ?? "", category: snapshot.page.category };
  const out = chunks.map((c) => {
    const answer = JSON.stringify({ labels: c.labeled.map((b) => ({ id: b.id, c: "N", u: false, m: false })) });
    return { n_blocks: c.labeled.length, context_blocks: c.context.length, user_tokens: lib.countTokens(lib.renderUserMessage(header, c)), out_tokens: lib.countTokens(answer) };
  });
  const sum = (k) => out.reduce((n, c) => n + c[k], 0);
  return { eligible_units: blocks.length, units_sent: sum("n_blocks"), context_blocks: sum("context_blocks"), chunks: out };
}

const MODELS = [
  { id: "claude-sonnet-5-5", thinking: "off", configuration: "thinking off (between_tools), no temperature" },
  { id: "claude-opus-5-5", thinking: "model-default", effort: "low", configuration: "thinking always on, effort low, no temperature" },
  { id: "claude-haiku-5-5", thinking: "off", configuration: "thinking off (disabled), no temperature" },
];
const HEADROOM = 8000;

async function main(argv) {
  delete process.env["ANTHROPIC_API_KEY"]; // a dry run never needs it, and nothing here may use it
  const { values } = parseArgs({ args: argv, options: { root: { type: "string" }, out: { type: "string" }, "data-dir": { type: "string" }, pipeline: { type: "string" }, "cap-usd": { type: "string" }, "audit-completed-at": { type: "string" } } });
  const root = resolve(values.root ?? process.cwd());
  const out = resolve(root, values.out ?? "data/labeling");
  const dataDir = resolve(root, values["data-dir"] ?? join(out, "gp"));
  const capUsd = Number(values["cap-usd"] ?? 25);
  const pipelinePath = resolve(values.pipeline ?? join(HERE, "..", "pipelines", "dom-v0-labeling.json"));
  const [labels, contracts, markdown, cli, stages] = await Promise.all([
    load("../packages/labels/dist/index.js"),
    load("../packages/contracts/dist/index.js"),
    load("../packages/markdown/dist/index.js"),
    load("../tools/cli/dist/index.js"),
    load("../tools/cli/dist/stages/index.js"),
  ]);
  const lib = { ...labels, countTokens: markdown.countTokens };

  // 1. the pipeline, as a dry run
  const pipelineBytes = readFileSync(pipelinePath);
  const checked = cli.checkPipeline(JSON.parse(pipelineBytes.toString("utf8")), new cli.StageRegistry(stages.ALL_STAGES));
  if (!checked.ok) throw new Error(`the pipeline does not validate: ${JSON.stringify(checked.issues)}`);
  const spec = checked.spec;
  if (spec.vars?.dry_run !== true) throw new Error("pipelines/dom-v0-labeling.json must have vars.dry_run = true: this script never pays");
  const run = await cli.runPipeline(spec, { dataDir, root, plugins: stages.ALL_STAGES, budgetUSD: 0 });
  const failed = run.stages.filter((s) => s.status === "failed");
  if (failed.length > 0) throw new Error(`pipeline stages failed: ${failed.map((s) => `${s.stageId}: ${s.error}`).join("; ")}`);
  const store = new cli.ArtifactStore(cli.dataPaths(dataDir).artifacts);
  const stage = (id) => run.stages.find((s) => s.stageId === id);
  const report = (id) => store.handle(stage(id).outputs["report"], "Bundle").json();
  const reports = { dev: report("llm_dev"), test: report("llm_test") };
  for (const r of Object.values(reports)) if (!r.dry_run || r.totals.calls !== 0 || r.totals.spent_usd !== 0) throw new Error("the label.llm report is not a dry run with zero calls");
  const reportByPage = new Map([...reports.dev.pages, ...reports.test.pages].map((p) => [p.snapshot_id, p]));

  // 2. the frozen corpus, checked against its lock
  const corpusDir = resolve(root, spec.externals.snapshots.path);
  const manifestBytes = readFileSync(join(corpusDir, "manifest.json"));
  const lockPath = resolve(corpusDir, "..", "corpus-v0.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const lockSha = `sha256:${sha256(readFileSync(lockPath))}`;
  const freeze = JSON.parse(readFileSync(resolve(HERE, "..", "pipelines", "dom-v0-corpus-freeze.json"), "utf8"));
  if (lockSha !== freeze.lock_sha256) throw new Error(`the corpus lock is ${lockSha}, not the frozen ${freeze.lock_sha256}`);
  if (`sha256:${sha256(manifestBytes)}` !== lock.files["snapshot-set/manifest.json"]) throw new Error("the snapshot-set manifest differs from the lock");
  const snaps = new labels.SnapshotSetReader({ file: (p) => new Uint8Array(readFileSync(join(corpusDir, p))) });
  const feats = new labels.NodeFeaturesSetReader(store.handle(stage("extract").outputs["features"], "NodeFeaturesSet"));
  const featByHash = new Map(feats.entries().map((e) => [e.snapshot_id, e]));
  const { salt, ranges } = freeze.split;

  const pages = snaps.entries().map((e) => ({
    snapshot_id: e.snapshot_id, url: e.url, category: e.stratum, group_key: e.group_key,
    split: contracts.assignSplit(salt, e.group_key, { ranges }).split, entry: e,
  }));
  const bySplit = (s) => pages.filter((p) => p.split === s).length;
  for (const [k, n] of Object.entries(freeze.split.counts)) if (k !== "dev" && bySplit(k) !== n) throw new Error(`split ${k}: ${bySplit(k)} pages, the freeze record says ${n}`);
  const inPipeline = (r) => new Set(r.pages.map((p) => p.snapshot_id));
  for (const p of pages) {
    const want = p.split === "test" ? "test" : "dev";
    if (!inPipeline(reports[want]).has(p.snapshot_id)) throw new Error(`${p.url} is a ${p.split} page but the pipeline's ${want} stage did not route it`);
  }

  // 3. selections
  const sel = selectPages(pages, DEFAULT_SIZES);
  const roles = new Map(pages.map((p) => [p.snapshot_id, []]));
  for (const t of PURPOSES) for (const p of sel[t]) roles.get(p.snapshot_id).push(t);

  // 4. the real prompt and the tokens of every phase
  const sys = labels.buildSystemPrompt(resolve(root, "IDEIAS/plano/guia-de-anotacao.md"), freeze.guide_sha256 ?? spec.vars.guide_sha256);
  const system_tokens = lib.countTokens(sys.system);
  const cfg = { block: labels.DEFAULT_BLOCK_PARAMS, chunk_blocks: 400, ctx_blocks: 10 };
  const phaseOf = (page) => {
    const r = roles.get(page.snapshot_id);
    if (r.includes("prompt-dev")) return "prompt-dev";
    if (r.includes("audit")) return "audit";
    if (r.includes("test-review")) return "test-review";
    return "routing";
  };
  const PHASES = {
    "prompt-dev": { mode: "all", iterations: 3, interactive: true, label: "prompt-dev (10 pages, up to 3 prompt versions)" },
    audit: { mode: "all", iterations: 1, interactive: false, label: "audit (all test categories)" },
    routing: { mode: "disagreement", iterations: 1, interactive: false, label: "routing of train + val" },
    "test-review": { mode: "all", iterations: 1, interactive: false, label: "test-review (LLM draft)" },
  };
  const acc = Object.fromEntries(Object.keys(PHASES).map((k) => [k, { chunks: [], pages: 0, eligible: 0, sent: 0, ctx: 0 }]));
  const planPages = [];
  for (const p of pages) {
    const snapshot = snaps.snapshot(p.entry);
    const fe = featByHash.get(p.snapshot_id);
    const units = lib.eligibleUnits(snapshot, feats.features(fe));
    const rep = reportByPage.get(p.snapshot_id);
    const phase = phaseOf(p);
    const mode = PHASES[phase].mode;
    // "all": every eligible unit; "disagreement": what the pipeline's routing chose (the human layer, once it exists, removes prompt-dev pages)
    const routed = mode === "all" ? units : rep.routed_unit_ids;
    const tk = pageTokens({ snapshot, units, routed, lib, cfg });
    const a = acc[phase];
    a.chunks.push(...tk.chunks.map((c) => ({ user_tokens: c.user_tokens, out_tokens: c.out_tokens })));
    a.pages++; a.eligible += tk.eligible_units; a.sent += tk.units_sent; a.ctx += tk.context_blocks;
    const sum = (k) => tk.chunks.reduce((n, c) => n + c[k], 0);
    planPages.push({
      snapshot_id: p.snapshot_id, url: p.url, category: p.category, group_key: p.group_key, split: p.split,
      roles: roles.get(p.snapshot_id),
      human_task: roles.get(p.snapshot_id).length > 0 ? roles.get(p.snapshot_id).map((t) => `${t}: ${TASKS[t].human_task}`) : ["none: labeled by the routing (extractors + LLM); doubtful blocks go to the human queue (5.3)"],
      llm: {
        phase, mode, iterations: PHASES[phase].iterations,
        routing: { whole_page: mode === "all" ? null : rep.routing.page_whole, by_reason: mode === "all" ? { all: tk.units_sent } : rep.routing.counts.by_reason },
        eligible_units: tk.eligible_units, units_sent: tk.units_sent, context_blocks: tk.context_blocks, chunks: tk.chunks.length,
        input_tokens_user_cl100k: sum("user_tokens"), output_tokens_cl100k: sum("out_tokens"),
        note: phase === "prompt-dev" ? "the human label from scratch settles these pages, so the routing phase never sends them; the LLM runs on all nodes only to iterate the prompt" : undefined,
      },
    });
  }
  const phaseRows = Object.entries(PHASES).map(([k, ph]) => {
    const a = acc[k];
    return { name: k, label: ph.label, routing: ph.mode, iterations: ph.iterations, interactive: ph.interactive, pages: a.pages, eligible_units: a.eligible, units_sent: a.sent, context_blocks: a.ctx, chunks: a.chunks.length, user_tokens: a.chunks.reduce((n, c) => n + c.user_tokens, 0), out_tokens: a.chunks.reduce((n, c) => n + c.out_tokens, 0) };
  });
  const dev = planPages.filter((x) => x.llm.phase === "routing");
  const reasons = {};
  const wholeReasons = {};
  for (const x of dev) {
    for (const [k, v] of Object.entries(x.llm.routing.by_reason)) reasons[k] = (reasons[k] ?? 0) + v;
    if (x.llm.routing.whole_page) wholeReasons[x.llm.routing.whole_page] = (wholeReasons[x.llm.routing.whole_page] ?? 0) + 1;
  }

  // 5. cost per model
  const costModels = MODELS.map((m) => {
    const rules = labels.MODEL_RULES[m.id];
    return modelCost({
      model: { id: m.id, configuration: m.configuration, prices: rules.prices, thinking_on: m.thinking !== "off", thinking_headroom_tokens: m.thinking === "off" ? 0 : HEADROOM,
        thinking_note: m.thinking === "off" ? "Thinking is off: no thinking tokens are billed." : "Thinking cannot be turned off on this model and its tokens are UNMEASURED: the expected figure counts none, the upper figure bills the whole 8000-token headroom of every call." },
      system_tokens,
      cap_usd: capUsd,
      phases: Object.entries(PHASES).map(([k, ph]) => ({ name: k, pages: acc[k].pages, chunks: acc[k].chunks, iterations: ph.iterations, interactive: ph.interactive })),
    });
  });

  // 6. the plan
  const categories = [...new Set(pages.map((p) => p.category))].sort();
  const view = (t) => ({
    mode: TASKS[t].mode, human_task: TASKS[t].human_task, pages: sel[t].map((p) => p.snapshot_id),
    by_category: countsBy(sel[t], "category"), by_split: countsBy(sel[t], "split"),
    ...(t === "audit" ? { per_category_rule: "first 5 of each category of the test split; a category with fewer takes all of them (SPA: 3 in the test, DESVIOS #13), so the total is 28", by_category_taken: sel.audit_by_category } : {}),
    ...(t === "retest" ? { not_before_rule: "7 days or more after the audit is finished (5.4)" } : {}),
    ...(t === "train-sample" ? { size_rule: `ceil(0.1 x ${pages.filter((p) => p.split === "train").length} train pages) = ${sel.n_train_sample}, excluding the prompt-dev pages` } : {}),
  });
  const plan = {
    format: PLAN_FORMAT, format_version: "1.0.0", experiment: "dom-v0",
    inputs: {
      corpus: "frame-v0 (attempt 2)", pages: pages.length, lock_sha256: lockSha, snapshot_set_manifest_sha256: lock.files["snapshot-set/manifest.json"],
      split: { contract: "hash-bucket-v1", salt, ranges }, guide_sha256: `sha256:${sys.guide_sha256}`,
      pipeline: "pipelines/dom-v0-labeling.json", pipeline_sha256: `sha256:${sha256(pipelineBytes)}`,
    },
    selection_formula: `sha256("${ORDER_PREFIX}<purpose>|" + url) in ascending order (ties by url); purposes: ${PURPOSES.join(", ")}`,
    categories,
    corpus_by_split: ["train", "val", "test"].map((s) => ({ split: s, total: bySplit(s) })),
    corpus_split_by_category: Object.fromEntries(categories.map((c) => [c, Object.fromEntries(["train", "val", "test"].map((s) => [s, pages.filter((p) => p.category === c && p.split === s).length]))])),
    selections: Object.fromEntries(PURPOSES.map((t) => [t, view(t)])),
    system_prompt: { prompt_id: sys.prompt_id, prompt_sha256: sys.prompt_sha256, chars: sys.system.length, tokens_cl100k: system_tokens },
    phases: phaseRows,
    routing_dev: { pages: dev.length, eligible_units: dev.reduce((n, x) => n + x.llm.eligible_units, 0), units_sent: dev.reduce((n, x) => n + x.llm.units_sent, 0), whole_page_pages: dev.filter((x) => x.llm.routing.whole_page).length, whole_page_reasons: wholeReasons, by_reason: reasons },
    pages: planPages,
    cost: {
      cap_usd: capUsd, token_proxy: "cl100k_base (js-tiktoken), the proxy of protocol 10; the tokenizer of Claude is not public", token_uncertainty_upper: TOKEN_UNCERTAINTY,
      scenarios: SCENARIOS, models: costModels,
      assumptions: [
        `Input tokens are counted with cl100k_base on the exact text the labeler sends (system prompt = guide sections 1-4 + output instructions; user message per chunk of up to 400 blocks with 10 context blocks). The tokenizer of Claude is not public: "expected" uses the count as it is and "upper" multiplies it by ${TOKEN_UNCERTAINTY} (top of the 1.0-1.35 range of the newer Claude tokenizers over older ones). The real ratio is UNMEASURED (the drift hook of @gran-prix/markdown needs a key); protocol 10 asks for a check on 30 pages.`,
        "Output tokens are those of the answer format {\"labels\":[{\"id\":\"n123\",\"c\":\"M|S|N\",\"u\":false,\"m\":false}]} for every block sent, counted with cl100k; the real answers differ only in the letters and booleans.",
        `The system prompt (${system_tokens} cl100k tokens) is a cache write (1.25x input) on the first call of each prompt version and a cache read afterwards (calls of a phase are back to back, inside the 5-minute window). Whether a ${system_tokens}-token prefix is above the minimum cacheable length of each model is UNVERIFIED (it is not in the lane table); if it is not, every call pays the input price for it and the costs rise by system_tokens x calls x (input - read).`,
        "Retries: 5% (expected) or 10% (upper) of the calls are made twice (the labeler's bounded retry on missing or unknown ids).",
        "Prompt-dev: 10 pages, all nodes, 3 prompt versions at most, interactive (no batch), one cache write per version. The prompt-dev pages are human-settled afterwards, so the routing phase does not send them.",
        "Routing of train + val: the units the pipeline's routing chose (disagreement, abstention, whole page, 15% control sample) with the heuristic layers only; the human layer will not change it except for the prompt-dev pages.",
        "Thinking: Sonnet 5.5 and Haiku 5.5 run with thinking off. Opus 5.5 cannot, so its thinking tokens (billed as output) are not measured here: the expected figure counts none, the upper figure bills the 8000-token headroom of every call. Run one real call with the key to measure it before choosing Opus.",
        "Prices: Sonnet 5.5 $2/$10 (cache read $0.10), Opus 5.5 $4/$20 (cache read $0.20), Haiku 5.5 $0.10/$0.50 up to 100k tokens of prompt; cache write 1.25x input. The Haiku cache-read price is not in the lane table: 0.1x input is assumed (documented ratio).",
        "The cap of the protocol covers the labeling AND the QA of E3.4 (protocol 5.6: about $13 at the old prices, not recomputed here): the column \"left for the QA\" is what remains.",
      ],
    },
    interpretations: [
      "The order hash uses the page `url` (the frame url that the corpus walk hashes), not `final_url`.",
      "audit: 5 per category of the TEST split by the `audit` hash; the SPA has 3 test pages, so the total is 28 (28 = 5 x 5 + 3), a consequence of deviation #13.",
      "retest: the first 10 of the 28 audit pages by the `retest` hash, a subset of the audit; its queue opens 7 days or more after the audit (not_before is null until `--audit-completed-at` is given).",
      "train-sample: 10% of the train pages, ceil(0.1 x 98) = 10, taken among the train pages that are NOT prompt-dev (their label is already human from scratch). The protocol does not say whether prompt-dev pages are eligible.",
      "test-review: the 8 test pages outside the audit; the LLM drafts them with routing `all`, a human reviews every node.",
      "The prompt-dev LLM runs (up to 3 versions) are outside the pipeline file: they happen before the prompt and model are frozen. The pipeline carries the frozen-prompt routing.",
      "Defuddle runs with removeLowScoring false, the single variant chosen a priori (DESVIOS #11); Trafilatura in recall mode (5.2, favor_recall); Readability with its h1 = title rule. Alignment coverage under 0.9 is an abstention.",
      "Doubtful blocks (u = true) go to a human queue by the protocol (5.3); it is not one of the five Studio tasks of this plan.",
    ],
  };
  mkdirSync(join(out, "queues"), { recursive: true });
  const planText = `${JSON.stringify(plan, null, 2)}\n`;
  const planSha = `sha256:${sha256(planText)}`;
  writeFileSync(join(out, "plan-v0.json"), planText);
  writeFileSync(join(out, "plan-v0.md"), renderPlanMarkdown(plan));
  const notBefore = retestNotBefore(values["audit-completed-at"]);
  for (const t of PURPOSES) writeFileSync(join(out, "queues", `${t}.json`), `${JSON.stringify(buildQueue(t, sel[t], planSha, t === "retest" ? notBefore : null), null, 2)}\n`);
  console.log(`plan written to ${out}: ${pages.length} pages, plan ${planSha}`);
  for (const t of PURPOSES) console.log(`  ${t}: ${sel[t].length} pages (${TASKS[t].mode})`);
  for (const m of costModels) console.log(`  ${m.model}: expected $${m.totals.expected.usd.toFixed(2)}, upper $${m.totals.upper.usd.toFixed(2)} (cap $${capUsd})`);
  if (!notBefore) console.log("  retest: not_before is null; re-run with --audit-completed-at <date> once the audit is done");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`labeling plan failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
