// E3.4, end to end and offline: the 13 synthetic fixture pages go through collect, extract, the gold (truth rules), measure.tokens
// (D2 and the pruned markdown of every system) and then the four QA stages with a FAKE transport: candidates with the automatic
// validators, the human review (a file exported as the review page would), the task set, R1 and R2 over their arms, the scoring
// with the judge and the human sample, and the downstream reports go into the decision script, which decides.
// Needs Chromium (like the tokens test). No network, no key, no paid call.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertValid, contractId, groupBucket, type EvalReport, type PipelineSpec, type QaTaskSet, type Sha256 } from "@gran-prix/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without declarations
import { decide } from "../../../scripts/decide-dom-v0.mjs";
import { ArtifactStore, StageRegistry, checkPipeline, dataPaths, runPipeline, type RunSummary } from "../src/index.js";
import { ALL_STAGES } from "../src/stages/index.js";
import { createQaStages } from "../src/stages/qa/index.js";
import { GENERATOR_SYSTEM, JUDGE_SYSTEM, RESPONDENT_SYSTEM, CANDIDATE_KINDS } from "../src/stages/qa/prompts.js";
import { normalizeAnswer } from "../src/stages/qa/text.js";
import { QaFakeTransport, contentText, type QaRequest } from "../src/stages/qa/transport.js";
import type { CandidatesDoc, ReviewExport } from "../src/stages/qa/types.js";
import { evidenceOf, GO } from "./decide-fixtures.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURES = join(ROOT, "fixtures/pages");
const NAMES = ["article-1", "article-2", "docs-1", "docs-2", "docs-3", "forum-1", "forum-2", "landing-1", "landing-2", "product-1", "product-2", "spa-1", "spa-2"];
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const PRICES = { input_usd_per_mtok: 3, output_usd_per_mtok: 15 }; // example prices for the test, not a claim about any model
const TAU = 0.4;
const HASHES = { f: `sha256:${"a".repeat(64)}` as Sha256, l: `sha256:${"b".repeat(64)}` as Sha256 };
const MODEL_ID: Sha256 = `sha256:${"7".repeat(64)}`;

// ------------------------------------------------------------------------------------------------------------ the fake models
const words = (s: string): string[] => normalizeAnswer(s).split(" ").filter(Boolean);

/** One transport for the three roles, told apart by the system prompt. Questions and answers are remembered to play the respondent. */
function fakeModels(): { transport: QaFakeTransport; qa: Map<string, string[]> } {
  const qa = new Map<string, string[]>();
  const respond = (req: QaRequest): string => {
    const user = contentText(req.messages[0]!.content);
    if (req.system === GENERATOR_SYSTEM) {
      const d2 = user.slice(user.indexOf("<<<PAGE\n") + 8, user.lastIndexOf("\nPAGE>>>"));
      const lines = d2.split("\n").map((l) => l.trim()).filter((l) => words(l).length >= 5 && l.length <= 300 && d2.split(l).length === 2);
      const support = lines.filter((l) => /\b(by|posted|published|updated|reply|score|rating|date|\d{4})\b/i.test(l));
      const plain = lines.filter((l) => !support.includes(l));
      const out = CANDIDATE_KINDS.map((kind, i) => {
        const pool = kind === "support" && support.length > 0 ? support : plain.length > 0 ? plain : lines;
        const line = pool[(i * 3) % Math.max(1, pool.length)] ?? "no usable line on this page here now";
        const w = line.replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter(Boolean);
        const answer = w.slice(-2).join(" ");
        const question = `According to the page, what follows "${w.slice(0, 3).join(" ")}"?`;
        qa.set(question, [...(qa.get(question) ?? []), answer]);
        return { kind, question, answer, answer_variants: [], evidence_quote: line };
      });
      return JSON.stringify({ candidates: out });
    }
    if (req.system === RESPONDENT_SYSTEM) {
      const question = /Question: (.*)$/s.exec(user)?.[1] ?? "";
      const page = user.startsWith("<page>") ? normalizeAnswer(user.slice(0, user.indexOf("</page>"))) : null;
      const answers = qa.get(question) ?? [];
      const hit = page === null ? undefined : answers.find((a) => ` ${page} `.includes(` ${normalizeAnswer(a)} `));
      if (hit === undefined) return "NOT_FOUND";
      // every third question is answered in a paraphrase a string match cannot decide: it goes to the judge
      return question.length % 3 === 0 ? words(hit).reverse().join(" ") : `The page says ${hit}.`;
    }
    if (req.system === JUDGE_SYSTEM) {
      const j = JSON.parse(user) as { answer_key: string; response: string };
      const a = words(j.answer_key).sort().join(" ");
      const r = words(j.response).sort().join(" ");
      return JSON.stringify({ verdict: a === r ? "correct" : "incorrect" });
    }
    throw new Error("unexpected system prompt");
  };
  return { transport: new QaFakeTransport(respond), qa };
}

// ------------------------------------------------------------------------------------------------------------ the pipelines
function baseStages(urlsPath: string): PipelineSpec["stages"] {
  const rules = (name: string): unknown[] => readJson<{ rules: Array<{ label: string }> }>(join(FIXTURES, `${name}.truth.json`)).rules;
  const truthPages = (keep: (l: string) => boolean): unknown[] => NAMES.map((n) => ({ url_contains: `/${n}.html`, rules: (rules(n) as Array<{ label: string }>).filter((r) => keep(r.label)) }));
  const SNAP = { snapshots: { stage: "collect", output: "snapshots" }, features: { stage: "extract", output: "features" } };
  void urlsPath;
  return [
    { id: "collect", kind: "collect", impl: "ts:collect.playwright@1.0.0", params: { viewport: [1280, 900], captured_at: "2026-01-01T00:00:00Z", fail_on_error: true }, inputs: { urls: { external: "urls" } } },
    { id: "extract", kind: "extract", impl: "ts:extract.dom-node@1.0.0", params: {}, inputs: { snapshots: { stage: "collect", output: "snapshots" }, schema: { external: "schema" } } },
    { id: "gold", kind: "label", impl: "ts:label.truth@1.0.0", params: { pages: truthPages(() => true) }, inputs: SNAP },
    { id: "gold_main", kind: "label", impl: "ts:label.truth@1.0.0", params: { pages: truthPages((l) => l === "main") }, inputs: SNAP },
    { id: "heur", kind: "label", impl: "ts:label.heuristic@1.0.0", params: { min_coverage: 0 }, inputs: SNAP },
    {
      id: "tokens",
      kind: "evaluate",
      impl: "ts:measure.tokens@1.0.0",
      params: { names: ["oracle", "model", "router", "readability", "trafilatura", "defuddle"] },
      inputs: {
        snapshots: { stage: "collect", output: "snapshots" },
        systems: ["gold", "heur", "gold_main", "heur", "gold_main", "heur"].map((s) => ({ stage: s, output: "labels" })),
      },
    },
    {
      id: "gen",
      kind: "evaluate",
      impl: "ts:qa.generate@1.0.0",
      params: { generator: { model: "test-opus-model", prices: PRICES }, seed: "20261125" },
      inputs: { snapshots: { stage: "collect", output: "snapshots" }, markdown: { stage: "tokens", output: "markdown" }, gold: { stage: "gold", output: "labels" } },
    },
  ];
}

function qaStages(humanExternal: string | undefined): PipelineSpec["stages"] {
  const ans = (id: string, respondent: "r1" | "r2", model: string): PipelineSpec["stages"][number] => ({
    id,
    kind: "evaluate",
    impl: "ts:qa.answer@1.0.0",
    params: { respondent, llm: { model, prices: PRICES }, concurrency: 3 },
    inputs: { taskset: { stage: "taskset", output: "taskset" }, markdown: { stage: "tokens", output: "markdown" } },
  });
  const score = (id: string, answers: string, judge: string, human?: string): PipelineSpec["stages"][number] => ({
    id,
    kind: "evaluate",
    impl: "ts:qa.score@1.0.0",
    params: { judge: { model: judge, prices: PRICES }, model_id: MODEL_ID, threshold: TAU, resamples: 2000, fact_max_words: 1 },
    inputs: { taskset: { stage: "taskset", output: "taskset" }, answers: { stage: answers, output: "answers" }, markdown: { stage: "tokens", output: "markdown" }, ...(human ? { human: { external: human } } : {}) },
  });
  return [
    { id: "taskset", kind: "evaluate", impl: "ts:qa.taskset@1.0.0", params: {}, inputs: { candidates: { stage: "gen", output: "candidates" }, review: { external: "review" } } },
    ans("ans_r1", "r1", "test-haiku-model"),
    ans("ans_r2", "r2", "test-sonnet-model"),
    score("score_r1", "ans_r1", "test-sonnet-model", humanExternal),
    // the judge must differ from the respondent: R2 is the intermediate tier, so its judge is another model
    score("score_r2", "ans_r2", "test-opus-model"),
  ];
}

function spec(urls: string, review: string | undefined, human?: string): PipelineSpec {
  return {
    format: "gran-prix.pipeline-spec",
    format_version: "1.0.0",
    name: "qa-e2e",
    externals: {
      urls: { type: "UrlList", path: urls },
      schema: { type: "FeatureSchema", path: "packages/features/src/schema/feature-schema.v0.json" },
      ...(review ? { review: { type: "Bundle", path: review } } : {}),
      ...(human ? { human: { type: "Bundle", path: human } } : {}),
    },
    stages: review ? [...baseStages(urls), ...qaStages(human ? "human" : undefined)] : baseStages(urls),
  } as PipelineSpec;
}

const out = (r: RunSummary, stage: string, port: string): Sha256 => {
  const id = r.stages.find((s) => s.stageId === stage)?.outputs[port];
  if (typeof id !== "string") throw new Error(`no output ${stage}.${port}`);
  return id as Sha256;
};
const text = (b: Uint8Array): string => Buffer.from(b).toString("utf8");

let dir: string;
let dataDir: string;
let store: ArtifactStore;
let models: ReturnType<typeof fakeModels>;
let plugins: ReturnType<typeof ALL_STAGES.filter>;
let run1: RunSummary;
let run2: RunSummary;
let candidates: CandidatesDoc;
let reviewJson: ReviewExport;
const reports: Record<string, EvalReport> = {};
let taskSet: QaTaskSet;

const stageErrors = (r: RunSummary): string => JSON.stringify(r.stages.filter((s) => s.error).map((s) => [s.stageId, s.error]));

beforeAll(async () => {
  dir = tmpDir("gp-qa-e2e-");
  const urls = join(dir, "urls.json");
  writeFileSync(urls, JSON.stringify(NAMES.map((n) => ({ url: `fixtures/pages/${n}.html`, stratum: readJson<{ category: string }>(join(FIXTURES, `${n}.truth.json`)).category }))));
  dataDir = join(dir, "data");
  models = fakeModels();
  plugins = [...ALL_STAGES.filter((p) => !p.spec.impl.startsWith("ts:qa.")), ...createQaStages({ provider: "fake", make: () => models.transport })];

  // phase 1: up to the candidates and the review page
  run1 = await runPipeline(spec(urls, undefined), { dataDir, plugins, root: ROOT, budgetUSD: 50, log: () => undefined });
  store = new ArtifactStore(dataPaths(dataDir).artifacts);
  const cands = store.handle(out(run1, "gen", "candidates"), "Bundle");
  candidates = JSON.parse(text(cands.file("candidates.json"))) as CandidatesDoc;

  // the human: accepts every candidate the page shows (what the page would export after a review of everything)
  const decisions = candidates.pages.flatMap((p) => p.candidates.filter((c) => c.auto.status === "pass").map((c) => ({ group_id: p.group_id, rank: c.rank, answers_from_page: true, unique: true, correct: true })));
  reviewJson = { format: "gran-prix.qa-review", format_version: "1.0.0", candidates_id: candidates.candidates_id, reviewer: "tester", decisions };
  const review = join(dir, "review.json");
  writeFileSync(review, JSON.stringify(reviewJson));

  // phase 2: the rest of the study (the earlier stages come from the cache)
  run2 = await runPipeline(spec(urls, review), { dataDir, plugins, root: ROOT, budgetUSD: 50, log: () => undefined });
  if (run2.ok) {
    taskSet = store.handle(out(run2, "taskset", "taskset"), "QaTaskSet").json() as QaTaskSet;
    for (const r of ["score_r1", "score_r2"]) reports[r] = store.handle(out(run2, r, "report"), "EvalReport").json() as EvalReport;
  }
}, 600_000);

describe("the QA tool end to end (fake transport, 13 fixture pages)", () => {
  it("registers four stages with the right determinism and the pipeline passes the registry check", () => {
    const reg = new StageRegistry(ALL_STAGES);
    expect(reg.get("ts:qa.generate@1.0.0")!.spec.determinism).toBe("cached-external");
    expect(reg.get("ts:qa.answer@1.0.0")!.spec.determinism).toBe("cached-external");
    expect(reg.get("ts:qa.score@1.0.0")!.spec.determinism).toBe("cached-external");
    expect(reg.get("ts:qa.taskset@1.0.0")!.spec.determinism).toBe("pure");
    const r = checkPipeline(spec("x", "y", "z"), new StageRegistry(plugins));
    expect(r.ok ? [] : r.issues).toEqual([]);
  });

  it("phase 1 runs; every page got candidates (the unit map held on all 13 pages), and the page is a static file", () => {
    expect(run1.ok, stageErrors(run1)).toBe(true);
    expect(candidates.pages).toHaveLength(13);
    const notOk = candidates.pages.filter((p) => p.status !== "ok").map((p) => [p.group_id, p.status, p.reason]);
    expect(notOk).toEqual([]);
    expect(candidates.generator).toMatchObject({ model: "test-opus-model", source: "D2 full-page markdown", request: { send_temperature: false } });
    for (const p of candidates.pages) expect(p.candidates, p.group_id).toHaveLength(7);
    const rej = candidates.validation.rejection;
    expect(rej.n_candidates).toBe(13 * 7);
    expect(rej.n_candidates - rej.n_rejected).toBeGreaterThan(20); // some pass, some do not: the validators are doing something
    const html = text(store.handle(out(run1, "gen", "review"), "Bundle").file("review.html"));
    const code = html.replace(/<script type="application\/json"[\s\S]*?<\/script>/, ""); // the page text is data (it may quote URLs); the code is what must not reach out
    expect(code).not.toMatch(/<script[^>]*\ssrc=|<link\b|<img\b|https?:\/\//i);
    expect(html).toContain("QA candidate review");
    for (const p of candidates.pages) for (const c of p.candidates.filter((x) => x.auto.status === "pass")) expect(c.evidence!.class === "main" || c.evidence!.class === "support").toBe(true);
  });

  it("phase 2 runs: task set, R1, R2 and both scorings", () => {
    expect(run2.ok, stageErrors(run2)).toBe(true);
    expect(run2.stages.filter((s) => s.status === "cached").map((s) => s.stageId)).toEqual(expect.arrayContaining(["collect", "extract", "gold", "tokens", "gen"]));
  });

  it("the task set validates against its contract, covers every hard category, and keeps no evidence in noise", () => {
    assertValid("qa-task-set", taskSet);
    expect(taskSet.review.human_reviewed).toBe(true);
    for (const c of ["product", "docs", "forum", "landing", "spa"]) expect(taskSet.tasks.some((t) => t.stratum === c), c).toBe(true);
    expect(taskSet.tasks.every((t) => t.evidence.class !== ("noise" as string))).toBe(true);
    expect(taskSet.tasks.every((t) => t.answer.trim().split(/\s+/).length <= 20)).toBe(true);
    const per = new Map<string, number>();
    for (const t of taskSet.tasks) per.set(t.group_id, (per.get(t.group_id) ?? 0) + 1);
    expect(Math.max(...per.values())).toBeLessThanOrEqual(5);
  });

  it("R1 asked eight arms and R2 five, with the fixed respondent prompt; the answers are in the cache and the ledger is bounded", () => {
    const a1 = JSON.parse(text(store.handle(out(run2, "ans_r1", "answers"), "Bundle").file("answers.json"))) as { arms: string[]; rows: unknown[]; status: string; model: string };
    const a2 = JSON.parse(text(store.handle(out(run2, "ans_r2", "answers"), "Bundle").file("answers.json"))) as { arms: string[]; rows: unknown[]; status: string; model: string };
    expect(a1.arms).toEqual(["full_page", "pruned_model", "oracle", "closed_book", "pruned_router", "pruned_readability", "pruned_trafilatura", "pruned_defuddle"]);
    expect(a2.arms).toEqual(["full_page", "pruned_model", "oracle", "closed_book", "pruned_router"]);
    expect(a1.rows).toHaveLength(taskSet.tasks.length * 8);
    expect(a2.rows).toHaveLength(taskSet.tasks.length * 5);
    expect([a1.status, a2.status]).toEqual(["complete", "complete"]);
    const used = new Set(models.transport.calls.map((c) => c.system));
    expect(used).toEqual(new Set([GENERATOR_SYSTEM, RESPONDENT_SYSTEM, JUDGE_SYSTEM]));
    expect(models.transport.calls.every((c) => c.maxTokens > 0 && !("temperature" in c))).toBe(true);
  });

  it("each downstream report is a valid EvalReport with the arms, the category arms, the deltas and the retention the decision reads", () => {
    for (const [r, arms] of [["score_r1", 8], ["score_r2", 5]] as const) {
      const rep = reports[r]!;
      assertValid("eval-report", rep);
      const d = rep.downstream!;
      expect(rep.mode).toBe("downstream");
      expect(rep.model_id).toBe(MODEL_ID);
      expect(rep.threshold).toBe(TAU);
      expect(d.task_set_id).toBe(taskSet.task_set_id);
      expect(d.bootstrap).toMatchObject({ resamples: 2000, seed: 20261125, cluster_by: "group_key", method: "percentile", stratified: false });
      for (const a of ["full_page", "pruned_model", "pruned_router", "oracle", "closed_book"]) expect(d.arms[a], `${r} ${a}`).toBeDefined();
      expect(Object.keys(d.arms).filter((k) => !k.includes("@") && !k.includes("~"))).toHaveLength(arms);
      for (const c of ["product", "docs", "forum", "landing", "spa"]) {
        expect(d.arms[`pruned_model@${c}`], c).toBeDefined();
        expect(d.paired_deltas.some((p) => p.a === `pruned_model@${c}` && p.b === `full_page@${c}`), c).toBe(true);
        expect(d.arms["pruned_model"]!.evidence_retention!.by_stratum![c]!.n_questions, c).toBeGreaterThan(0);
      }
      expect(d.arms["full_page"]!.evidence_retention!.mean).toBe(1); // the quote is a literal piece of D2
      expect(d.arms["oracle"]!.evidence_retention!.mean).toBeGreaterThanOrEqual(0.9); // gold evidence goes through the same converter
      expect(d.arms["closed_book"]!.evidence_retention).toBeUndefined();
      expect(d.arms["closed_book"]!.score_mean).toBe(0); // the fake never answers without a page
      expect(d.judge.kind).toBe("llm"); // some paraphrases went to the judge
      expect(d.judge.model).toBe(r === "score_r1" ? "test-sonnet-model" : "test-opus-model");
      expect(d.llm.model).toBe(r === "score_r1" ? "test-haiku-model" : "test-sonnet-model");
    }
  });

  it("with a dataset the splits decide: test pages first, dev pages complete the quota and are predicted out-of-fold; a dry run plans without a call", async () => {
    const fixture = readJson<Record<string, unknown> & { groups: Array<Record<string, unknown>>; sources: Array<Record<string, unknown>> }>(join(ROOT, "packages/contracts/fixtures/valid/dataset/manifest.json"));
    // per category: its first page is test, the second val, every other one train (the manifest records them as overrides of the hash split)
    const nth = new Map<string, number>();
    const splits = new Map<string, "train" | "val" | "test">();
    for (const p of candidates.pages) {
      const k = nth.get(p.stratum) ?? 0;
      nth.set(p.stratum, k + 1);
      splits.set(p.group_key, k === 0 ? "test" : k === 1 ? "val" : "train");
    }
    const groups = [...candidates.pages]
      .sort((a, b) => (a.group_id < b.group_id ? -1 : 1))
      .map((p) => ({ group_id: p.group_id, group_key: p.group_key, stratum: p.stratum, split: splits.get(p.group_key) as string, bucket: groupBucket("fixture-v1", p.group_key), n_rows: 1, n_pos: 1 }));
    const rowsOf = (n: string): number => groups.filter((g) => g.split === n).length;
    const fFiles = fixture["files"] as Record<string, Record<string, unknown>>;
    const manifest = {
      ...fixture,
      split: { ...(fixture["split"] as object), overrides: Object.fromEntries(splits) },
      groups,
      sources: groups.map((g) => ({ group_id: g.group_id, features_id: HASHES.f, labels_id: HASHES.l })),
      files: Object.fromEntries(["train", "val", "test"].map((n) => [n, { ...fFiles[n], rows: rowsOf(n) }])),
      stats: { by_split: Object.fromEntries(["train", "val", "test"].map((n) => [n, { rows: rowsOf(n), pos_rate: 1 }])), by_stratum: {} },
    };
    delete (manifest as Record<string, unknown>)["dataset_id"];
    const withId = { ...manifest, dataset_id: contractId("dataset-manifest", manifest as Record<string, unknown>) };
    assertValid("dataset-manifest", withId);
    const files = new Map<string, Uint8Array>([["manifest.json", new TextEncoder().encode(JSON.stringify(withId))]]);
    const dataset = { id: HASHES.f, type: "Dataset", dir: "", json: () => ({}), files: () => [...files.keys()], file: (f: string) => files.get(f) as Uint8Array };
    const gen = createQaStages({ provider: "fake", make: () => models.transport }).find((s) => s.spec.impl === "ts:qa.generate@1.0.0")!;
    const before = models.transport.calls.length;
    const ctx = {
      params: { generator: { model: "test-opus-model", prices: PRICES }, quota: { docs: 2, article: 1 }, dry_run: true },
      inputs: { snapshots: store.handle(out(run1, "collect", "snapshots"), "SnapshotSet"), markdown: store.handle(out(run1, "tokens", "markdown"), "Bundle"), gold: store.handle(out(run1, "gold", "labels"), "NodeLabelsSet"), dataset },
      ledger: { reserve: () => { throw new Error("a dry run reserves nothing"); }, capUSD: 100, remainingUSD: () => 100 },
      log: () => undefined,
      dataDir: join(dir, "data-dry"),
    } as unknown as Parameters<typeof gen.run>[0];
    const res = (await gen.run(ctx)) as { candidates: { files: Record<string, string> }; report: { json: { pages: Record<string, number> } } };
    const doc = JSON.parse(res.candidates.files["candidates.json"] as string) as CandidatesDoc;
    expect(models.transport.calls.length).toBe(before);
    const sel = doc.pages.filter((p) => p.status === "dry_run");
    expect(sel.filter((p) => p.stratum === "article").map((p) => [p.split, p.prediction])).toEqual([["test", "frozen_model"]]);
    const docs = sel.filter((p) => p.stratum === "docs");
    expect(docs).toHaveLength(2);
    expect(docs.filter((p) => p.split === "test").map((p) => p.prediction)).toEqual(["frozen_model"]);
    expect(docs.filter((p) => p.split !== "test").map((p) => p.prediction)).toEqual(["oof"]);
    expect(doc.selection.by_stratum["docs"]).toEqual({ wanted: 2, got: 2, test: 1, dev: 1, available: 3 });
    expect(doc.dataset_id).toBe(withId.dataset_id);
  });

  it("a judge equal to the respondent is refused before any call", async () => {
    const t = new QaFakeTransport(() => "{}");
    const stages = createQaStages({ provider: "fake", make: () => t });
    const score = stages.find((s) => s.spec.impl === "ts:qa.score@1.0.0")!;
    const ans = JSON.parse(text(store.handle(out(run2, "ans_r2", "answers"), "Bundle").file("answers.json"))) as { model: string };
    const ctx = {
      params: { judge: { model: ans.model, prices: PRICES }, model_id: MODEL_ID, threshold: TAU },
      inputs: { taskset: store.handle(out(run2, "taskset", "taskset"), "QaTaskSet"), answers: store.handle(out(run2, "ans_r2", "answers"), "Bundle"), markdown: store.handle(out(run2, "tokens", "markdown"), "Bundle") },
      ledger: { reserve: () => { throw new Error("no call expected"); }, capUSD: 100, remainingUSD: () => 100 },
      log: () => undefined,
      dataDir: join(dir, "data"),
    } as unknown as Parameters<typeof score.run>[0];
    await expect(score.run(ctx)).rejects.toThrow(/judge must differ from the respondent/);
    expect(t.calls).toHaveLength(0);
  });

  it("a respondent equal to the generator is refused before any call", async () => {
    const t = new QaFakeTransport(() => "x");
    const ans = createQaStages({ provider: "fake", make: () => t }).find((s) => s.spec.impl === "ts:qa.answer@1.0.0")!;
    const ctx = {
      params: { respondent: "r1", llm: { model: taskSet.generator.model, prices: PRICES } },
      inputs: { taskset: store.handle(out(run2, "taskset", "taskset"), "QaTaskSet"), markdown: store.handle(out(run2, "tokens", "markdown"), "Bundle") },
      ledger: { reserve: () => { throw new Error("no call expected"); }, capUSD: 100, remainingUSD: () => 100 },
      log: () => undefined,
      dataDir: join(dir, "data"),
    } as unknown as Parameters<typeof ans.run>[0];
    await expect(ans.run(ctx)).rejects.toThrow(/generator and the respondent must differ/);
    expect(t.calls).toHaveLength(0);
  });

  it("the reports go into the decision script, which decides with the numbers it read from them", () => {
    const config = readJson<Record<string, unknown>>(join(ROOT, "pipelines/dom-v0-decision.json"));
    const e = evidenceOf(GO);
    e.qa = { r1: reports["score_r1"]!, r2: reports["score_r2"]! };
    const d = decide(e, config) as { verdict: string; gates: { G3: { respondents: Record<string, { delta_pp: number; ci_lower_pp: number; retention: number }>; flagged_categories: Record<string, string[]> } }; oracle?: unknown };
    expect(["GO", "GO_CONDITIONAL", "PIVOT", "NO-GO", "NO_GO_CONCEPT"].length).toBeGreaterThan(0);
    expect(typeof d.verdict).toBe("string");
    for (const r of ["r1", "r2"]) {
      const g = d.gates.G3.respondents[r]!;
      const mine = reports[`score_${r}`]!.downstream!;
      expect(Number.isFinite(g.delta_pp), r).toBe(true);
      expect(g.delta_pp).toBeCloseTo(mine.paired_deltas.find((p) => p.a === "pruned_model" && p.b === "full_page")!.mean_delta * 100, 9);
      expect(g.ci_lower_pp).toBeCloseTo(mine.paired_deltas.find((p) => p.a === "pruned_model" && p.b === "full_page")!.ci95[0] * 100, 9);
      expect(g.retention).toBe(mine.arms["pruned_model"]!.evidence_retention!.mean);
    }
  });

  it("phase 3: the human's grading of the judge sample comes back as an input and the agreement is reported", async () => {
    const sample = JSON.parse(text(store.handle(out(run2, "score_r1", "judge_review"), "Bundle").file("sample.json"))) as { sample_id: string; items: Array<{ task_id: string; arm: string; role: string }> };
    const details = JSON.parse(text(store.handle(out(run2, "score_r1", "details"), "Bundle").file("details.json"))) as { scored: Array<{ task_id: string; arm: string; judge?: string }>; status: string };
    expect(details.status).toBe("scored");
    expect(sample.items.length).toBeGreaterThan(0);
    expect(sample.items.every((i) => i.role === "sample")).toBe(true);
    const judged = details.scored.filter((s) => s.judge !== undefined).length;
    expect(sample.items.length / judged).toBeGreaterThanOrEqual(0.2);
    const verdicts = sample.items.map((i, k) => {
      const j = details.scored.find((s) => s.task_id === i.task_id && s.arm === i.arm)!.judge!;
      const flip = k === 0 && sample.items.length > 4;
      return { task_id: i.task_id, arm: i.arm, verdict: (j === "correct") !== flip ? "correct" : "incorrect" };
    });
    const human = join(dir, "human.json");
    writeFileSync(human, JSON.stringify({ format: "gran-prix.qa-judge-review", format_version: "1.0.0", sample_id: sample.sample_id, reviewer: "tester", verdicts }));
    const run3 = await runPipeline(spec(join(dir, "urls.json"), join(dir, "review.json"), human), { dataDir, plugins, root: ROOT, budgetUSD: 50, log: () => undefined });
    expect(run3.ok, stageErrors(run3)).toBe(true);
    const rep = store.handle(out(run3, "score_r1", "report"), "EvalReport").json() as EvalReport;
    assertValid("eval-report", rep);
    const agreement = rep.downstream!.judge.human_agreement!;
    expect(agreement).toBeCloseTo(sample.items.length > 4 ? (sample.items.length - 1) / sample.items.length : 1, 12);
    expect(rep.gates?.find((g) => g.id === "QA_judge_agreement")).toMatchObject({ comparator: ">=", threshold: 0.9, value: agreement });
    expect(run3.stages.find((s) => s.stageId === "score_r2")!.status).toBe("cached");
    // the judge's verdict stays the score: the human file changes the agreement, not the accuracy
    expect(rep.downstream!.arms["full_page"]!.score_mean).toBe(reports["score_r1"]!.downstream!.arms["full_page"]!.score_mean);
  }, 300_000);

  it.skipIf(process.env["QA_VERBOSE"] === undefined)("(QA_VERBOSE=<file>) writes what the study produced to the file", () => {
    const d = (r: string): NonNullable<EvalReport["downstream"]> => reports[r]!.downstream!;
    const lines = [
      `tasks ${taskSet.tasks.length} on ${taskSet.pages.length} pages; review ${JSON.stringify(taskSet.review)}`,
      `automatic rejection ${JSON.stringify(candidates.validation.rejection)}`,
      ...["score_r1", "score_r2"].flatMap((r) => [
        `${r} arms: ${Object.entries(d(r).arms).filter(([k]) => !k.includes("@")).map(([k, a]) => `${k} n=${a.n} acc=${a.score_mean.toFixed(3)} ret=${a.evidence_retention?.mean.toFixed(3) ?? "-"}`).join(" | ")}`,
        `${r} deltas: ${d(r).paired_deltas.filter((p) => !p.a.includes("@")).map((p) => `${p.a} ${p.mean_delta.toFixed(3)} [${p.ci95.map((x) => x.toFixed(3)).join(",")}] p=${p.p_value?.toFixed(3)}`).join(" | ")}`,
      ]),
      `notes r1: ${reports["score_r1"]!.notes?.map((n) => n.text).join("\n  ")}`,
    ];
    writeFileSync(process.env["QA_VERBOSE"] as string, `${lines.join("\n")}\n`);
  });

  it("a second run of the whole study changes nothing and makes no call (the content-hash cache)", async () => {
    const before = models.transport.calls.length;
    const run = await runPipeline(spec(join(dir, "urls.json"), join(dir, "review.json")), { dataDir, plugins, root: ROOT, budgetUSD: 50, log: () => undefined, force: true, from: "gen" });
    expect(run.ok, stageErrors(run)).toBe(true);
    expect(models.transport.calls.length).toBe(before);
    expect(JSON.stringify(store.handle(out(run, "score_r1", "report"), "EvalReport").json())).toBe(JSON.stringify(reports["score_r1"]));
    expect(existsSync(join(dataDir, "qa-cache"))).toBe(true);
    void mkdirSync;
  }, 300_000);
});
