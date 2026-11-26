import { join } from "node:path";
import { assertValid, canonicalJson, sha256Of, type NodeLabels, type Sha256 } from "@gran-prix/contracts";
import { SnapshotSetReader, groupIdOf, indexBySnapshot, isBudgetError, readSetDocs, type SetMember } from "@gran-prix/labels";
import { COLLAPSED_CONTENT_IN_D2, converterDigests, converterLabel, type CollapsedPolicy } from "@gran-prix/markdown";
import { defineStage, type StagePlugin } from "../../stage.js";
import type { ArtifactHandle } from "../../store.js";
import { MarkdownBundle } from "./arms.js";
import { FsQaCache, estimateOf, mapPool, runCall, type QaCache } from "./call.js";
import { DEFAULT_PAGE_QUOTA, generatorPlan, rejectionStats, selectPages, validateCandidates, type PageRef, type SplitName } from "./generate.js";
import { LocateMismatch, locateUnits } from "./locate.js";
import { recordedParams, type ModelCaps } from "./model-params.js";
import { CANDIDATE_KINDS, GENERATOR_PROMPT_ID, GENERATOR_PROMPT_SHA256, KIND_QUOTA } from "./prompts.js";
import { candidateReviewHtml, type ReviewData } from "./review-html.js";
import { CAPABILITIES_SCHEMA, QA_CACHE_DIR, QaBudgetStopError, callModel, lazyTransport, modelBlock, num, optionalSingle, single, type ModelBlock, type QaStageDeps, REAL_DEPS } from "./stage-common.js";
import { CANDIDATES_FORMAT, type CandidatePage, type CandidatesDoc } from "./types.js";
import { goldClassMap as goldMap } from "./validators.js";

/**
 * `ts:qa.generate@1.0.0` (E3.4, protocol 9, step 1): the question candidates of the downstream QA study.
 *
 * Reads the pages (SnapshotSet), the D2 markdown that `ts:measure.tokens` wrote (Bundle `markdown`), the 3-class gold
 * (NodeLabelsSet) and, optionally, the Dataset (to know each page's split). Selects the pages (every test page plus dev
 * pages up to the quota per category, by the seed), asks the generator for 7 candidates per page from the D2 text,
 * and runs the automatic validators (the quote occurs exactly once; its elements have a gold class compatible with the
 * kind and none is noise; the question does not contain the answer). Writes the candidates document, the local review
 * page (`review.html`, static, no external resource, never to be published) and a report with the rejection rate.
 *
 * Money: `determinism: "cached-external"`. Every call is reserved from `ctx.ledger` first (the cap defaults to $0),
 * answered from the content-hash cache when it can be (`<data dir>/qa-cache/`), and `dry_run` plans without calling.
 */

export const GENERATE_IMPL = "ts:qa.generate@1.0.0";

const PARAMS_SCHEMA = {
  type: "object",
  required: ["generator"],
  additionalProperties: false,
  properties: {
    generator: modelBlock("The generator model: must differ from the respondents (protocol 9)."),
    capabilities: CAPABILITIES_SCHEMA,
    seed: { type: "string", minLength: 1, description: "Seed of the page draw (protocol section 13: 20261125). Default 20261125." },
    quota: { type: "object", additionalProperties: { type: "integer", minimum: 0 }, description: "Pages per category (default: article 10; product, docs, forum, landing, spa 18)." },
    default_split: { enum: ["train", "val", "test"], description: "Split of every page when no dataset is given (default test)." },
    dataset_id: { type: "string", pattern: "^sha256:[0-9a-f]{64}$", description: "Recorded in the task set when no dataset input is given." },
    collapsed: { enum: ["exclude", "include"], description: `Must be the policy ts:measure.tokens used (default "${COLLAPSED_CONTENT_IN_D2}"); a mismatch makes every page fail the D2 check.` },
    private_categories: { type: "array", items: { type: "string" }, description: "Categories whose text never goes to a cloud LLM (default [logged_in])." },
    min_quote_chars: { type: "integer", minimum: 1, description: "Shortest accepted evidence quote (default 12)." },
    max_quote_chars: { type: "integer", minimum: 1, description: "Longest accepted evidence quote (default 600)." },
    max_d2_chars: { type: "integer", minimum: 1, description: "Pages whose D2 is longer are excluded (default 400000)." },
    max_output_tokens: { type: "integer", minimum: 1, description: "max_tokens of a generator call (default 4000)." },
    concurrency: { type: "integer", minimum: 1, description: "Calls in flight (default 1)." },
    dry_run: { type: "boolean", description: "Plan and print (pages, calls, tokens, cost, cache hits); call nothing, spend nothing." },
    retry_failed: { type: "boolean", description: "Pay again for pages whose cached outcome is a failure." },
    on_budget: { enum: ["fail", "partial"], description: "When the ledger stops the run: fail the stage (default; finished work stays in the cache) or return the finished pages." },
  },
} as const;

interface Params {
  generator: ModelBlock;
  capabilities?: Record<string, ModelCaps>;
  seed?: string;
  quota?: Record<string, number>;
  default_split?: SplitName;
  dataset_id?: Sha256;
  collapsed?: CollapsedPolicy;
  private_categories?: string[];
  min_quote_chars?: number;
  max_quote_chars?: number;
  max_d2_chars?: number;
  max_output_tokens?: number;
  concurrency?: number;
  dry_run?: boolean;
  retry_failed?: boolean;
  on_budget?: "fail" | "partial";
}

const LABELS_FORMAT = "gran-prix.node-labels";
const dec = new TextDecoder();

interface Known {
  ref: Omit<PageRef, "prediction">;
  entry: ReturnType<SnapshotSetReader["entries"]>[number];
  excluded?: string;
}

export function createGenerateStage(deps: QaStageDeps = REAL_DEPS): StagePlugin {
  const stage = defineStage(
    {
      kind: "evaluate",
      impl: GENERATE_IMPL,
      inputs: [
        { name: "snapshots", type: "SnapshotSet" },
        { name: "markdown", type: "Bundle" },
        { name: "gold", type: "NodeLabelsSet" },
        { name: "dataset", type: "Dataset", optional: true },
      ],
      outputs: [
        { name: "candidates", type: "Bundle" },
        { name: "review", type: "Bundle" },
        { name: "report", type: "Bundle" },
      ],
      params_schema: PARAMS_SCHEMA,
      runtime: "node",
      determinism: "cached-external",
    },
    async (ctx) => {
      const p = ctx.params as unknown as Params;
      const model = callModel(deps.provider, p.generator, p.capabilities);
      const collapsed: CollapsedPolicy = p.collapsed ?? COLLAPSED_CONTENT_IN_D2;
      const seed = p.seed ?? "20261125";
      const quota = p.quota ?? DEFAULT_PAGE_QUOTA;
      const priv = new Set(p.private_categories ?? ["logged_in"]);
      const limits = { min: num(ctx.params, "min_quote_chars", 12), max: num(ctx.params, "max_quote_chars", 600) };
      const maxD2 = num(ctx.params, "max_d2_chars", 400_000);
      const maxTokens = num(ctx.params, "max_output_tokens", 4000);
      const dryRun = p.dry_run === true;
      const cache: QaCache = new FsQaCache(join(ctx.dataDir, QA_CACHE_DIR));
      const rt = { transport: lazyTransport(deps), ledger: ctx.ledger, cache, retryFailed: p.retry_failed === true };

      const snaps = new SnapshotSetReader(single(ctx, "snapshots"));
      const bundle = new MarkdownBundle(single(ctx, "markdown"));
      const goldBySnapshot = indexBySnapshot(readSetDocs<NodeLabels>(single(ctx, "gold"), LABELS_FORMAT) as SetMember<NodeLabels>[], "gold labels");
      const datasetHandle = optionalSingle(ctx, "dataset");
      const dataset = datasetHandle === undefined ? undefined : readManifest(datasetHandle);
      const splitOf = new Map((dataset?.groups ?? []).map((g) => [g.group_id, g.split]));

      // 1. every page of the set, with the reason it cannot be used (if any)
      const known: Known[] = snaps.entries().map((entry) => {
        const group_id = groupIdOf({ group_key: entry.group_key, snapshot_id: entry.snapshot_id } as Parameters<typeof groupIdOf>[0]);
        const split = dataset === undefined ? (p.default_split ?? "test") : splitOf.get(group_id);
        const ref = { group_id, group_key: entry.group_key, snapshot_id: entry.snapshot_id, stratum: entry.stratum, split: (split ?? "test") as SplitName };
        let excluded: string | undefined;
        if (priv.has(entry.stratum)) excluded = "private category: its text never goes to a cloud LLM";
        else if (dataset !== undefined && split === undefined) excluded = "not in the dataset (no split)";
        else if (!goldBySnapshot.has(entry.snapshot_id)) excluded = "no gold labels";
        else if (bundle.d2(entry.snapshot_id) === undefined) excluded = "no D2 in the markdown bundle";
        return { ref, entry, ...(excluded !== undefined ? { excluded } : {}) };
      });
      const eligible = known.filter((k) => k.excluded === undefined);
      const selection = selectPages(eligible.map((k) => k.ref), quota, seed);
      const byGroup = new Map(known.map((k) => [k.ref.group_id, k]));

      // 2. per selected page: D2, unit map, generator call, automatic validation
      const d2Of = new Map<string, string>();
      const pages: CandidatePage[] = [];
      const estimates = { calls: 0, cache_hits: 0, expected_usd: 0, worst_usd: 0, input_tokens: 0 };
      const work = async (ref: PageRef): Promise<{ page: CandidatePage; spent: number; calls: number }> => {
        const k = byGroup.get(ref.group_id) as Known;
        const base = { ...ref };
        const d2 = bundle.d2(ref.snapshot_id) as string;
        if (d2.trim() === "") return { page: { ...base, status: "excluded", reason: "empty D2", candidates: [] }, spent: 0, calls: 0 };
        if (d2.length > maxD2) return { page: { ...base, status: "excluded", reason: `D2 has ${d2.length} characters, more than max_d2_chars ${maxD2}`, candidates: [] }, spent: 0, calls: 0 };
        let located;
        try {
          const snapshot = snaps.snapshot(k.entry);
          located = locateUnits(snaps.html(k.entry), snapshot.nodes, collapsed);
        } catch (e) {
          const why = e instanceof LocateMismatch ? e.message : `unit map failed: ${e instanceof Error ? e.message : String(e)}`;
          return { page: { ...base, status: "excluded", reason: why, candidates: [] }, spent: 0, calls: 0 };
        }
        if (located.markdown !== d2) {
          return { page: { ...base, status: "excluded", reason: `the D2 of the markdown bundle differs from the converter's D2 (collapsed policy "${collapsed}"?)`, candidates: [] }, spent: 0, calls: 0 };
        }
        d2Of.set(ref.group_id, d2);
        const plan = generatorPlan(model, ref.stratum, d2, maxTokens);
        if (dryRun) {
          const e = estimateOf(plan, cache, rt.retryFailed, 1500);
          estimates.calls += e.hit ? 0 : 1;
          estimates.cache_hits += e.hit ? 1 : 0;
          if (!e.hit) {
            estimates.expected_usd += e.expected_usd;
            estimates.worst_usd += e.worst_usd;
            estimates.input_tokens += e.input_tokens;
          }
          return { page: { ...base, status: "dry_run", d2_sha256: sha256Of(d2), candidates: [] }, spent: 0, calls: 0 };
        }
        const o = await runCall(plan, rt);
        if (o.value === undefined) return { page: { ...base, status: "failed", reason: o.error ?? "invalid answer", d2_sha256: sha256Of(d2), candidates: [] }, spent: o.spent_usd, calls: o.calls };
        const gold = goldMap(goldBySnapshot.get(ref.snapshot_id)?.doc as NodeLabels);
        const candidates = validateCandidates(o.value, d2, located.spans, gold, limits);
        return { page: { ...base, status: "ok", d2_sha256: sha256Of(d2), candidates }, spent: o.spent_usd, calls: o.calls };
      };
      const pool = await mapPool(selection.selected, p.concurrency ?? 1, work);
      let spent = 0;
      let calls = 0;
      let cacheHits = 0;
      selection.selected.forEach((ref, i) => {
        const r = pool.results[i];
        if (r === undefined) {
          pages.push({ ...ref, status: "budget_stopped", candidates: [] });
          return;
        }
        pages.push(r.page);
        spent += r.spent;
        calls += r.calls;
        if (r.page.status !== "excluded" && r.calls === 0 && !dryRun) cacheHits++;
      });
      for (const k of known) {
        if (k.excluded !== undefined && quota[k.ref.stratum] !== undefined) pages.push({ ...k.ref, prediction: k.ref.split === "test" ? "frozen_model" : "oof", status: "excluded", reason: k.excluded, candidates: [] });
      }
      pages.sort((a, b) => (a.stratum < b.stratum ? -1 : a.stratum > b.stratum ? 1 : a.group_id < b.group_id ? -1 : a.group_id > b.group_id ? 1 : 0));
      if (pool.error !== undefined && !isBudgetError(pool.error)) throw pool.error;

      const versions = converterLabel();
      const bodyDoc = {
        format: CANDIDATES_FORMAT,
        format_version: "1.0.0" as const,
        dataset_id: p.dataset_id ?? dataset?.dataset_id ?? null,
        generator: { provider: deps.provider, model: model.model, prompt_id: GENERATOR_PROMPT_ID, prompt_sha256: GENERATOR_PROMPT_SHA256, request: recordedParams(model.params), source: "D2 full-page markdown", converter: versions, collapsed },
        selection: { seed, quota, by_stratum: selection.by_stratum, default_split: dataset === undefined ? (p.default_split ?? "test") : "from dataset" },
        validation: { min_quote_chars: limits.min, max_quote_chars: limits.max, rejection: rejectionStats(pages.filter((x) => x.status === "ok").map((x) => x.candidates)) },
        pages,
      };
      const candidates_id = sha256Of(canonicalJson(bodyDoc));
      const doc: CandidatesDoc = { ...bodyDoc, candidates_id } as CandidatesDoc;

      const reviewData: ReviewData = {
        candidates_id,
        kind_quota: { ...KIND_QUOTA },
        pages: pages
          .filter((x) => x.status === "ok" && x.candidates.some((c) => c.auto.status === "pass"))
          .map((x) => ({
            group_id: x.group_id,
            stratum: x.stratum,
            d2: d2Of.get(x.group_id) as string,
            candidates: x.candidates.filter((c) => c.auto.status === "pass").map((c) => ({ rank: c.rank, kind: c.kind, question: c.question, answer: c.answer, answer_variants: c.answer_variants, quote: c.quote, offset: c.evidence?.offset ?? 0, advisory: c.auto.advisory })),
          })),
      };

      const by = (s: CandidatePage["status"]): number => pages.filter((x) => x.status === s).length;
      const report = {
        format: "gran-prix.qa-generate-report",
        format_version: "1.0.0",
        dry_run: dryRun,
        generator: doc.generator,
        candidates_id,
        selection: doc.selection.by_stratum,
        pages: { selected: selection.selected.length, ok: by("ok"), failed: by("failed"), excluded: by("excluded"), dry_run: by("dry_run"), budget_stopped: by("budget_stopped") },
        excluded: pages.filter((x) => x.status === "excluded").map((x) => ({ group_id: x.group_id, stratum: x.stratum, reason: x.reason })),
        failed: pages.filter((x) => x.status === "failed").map((x) => ({ group_id: x.group_id, reason: x.reason })),
        rejection: doc.validation.rejection,
        cost: { calls, cache_hits: cacheHits, spent_usd: spent, ...(dryRun ? { estimate: estimates } : {}) },
        candidates_per_page: CANDIDATE_KINDS.length,
        kind_quota: KIND_QUOTA,
      };
      ctx.log(
        dryRun
          ? `DRY RUN (nothing spent): ${selection.selected.length} page(s) selected, ${estimates.calls} call(s) to pay, ${estimates.cache_hits} cache hit(s), ~${estimates.input_tokens} input tokens, estimated $${estimates.expected_usd.toFixed(4)} (worst case $${estimates.worst_usd.toFixed(4)})`
          : `${selection.selected.length} page(s) selected, ${by("ok")} with candidates, ${by("failed")} failed, ${by("excluded")} excluded; ${calls} call(s), spent $${spent.toFixed(4)}; automatic rejection ${(doc.validation.rejection.rate * 100).toFixed(1)}% of ${doc.validation.rejection.n_candidates}`,
      );
      if (pool.error !== undefined && (p.on_budget ?? "fail") === "fail") {
        throw new QaBudgetStopError(`stopped by the ledger: ${pool.error instanceof Error ? pool.error.message : String(pool.error)}. ${by("ok")} page(s) finished and every paid response is cached under ${join(ctx.dataDir, QA_CACHE_DIR)}: re-run with a larger --budget-usd to resume without paying twice`);
      }
      return {
        candidates: { files: { "candidates.json": `${canonicalJson(doc)}\n` } },
        review: { files: { "review.html": candidateReviewHtml(reviewData) } },
        report: { json: report },
      };
    },
  );
  return { ...stage, toolDigests: () => converterDigests() };
}

function readManifest(h: ArtifactHandle): { dataset_id: Sha256; groups: Array<{ group_id: string; split: SplitName }> } {
  if (!h.files().includes("manifest.json")) throw new Error(`dataset artifact ${h.id} has no manifest.json`);
  const m = assertValid("dataset-manifest", JSON.parse(dec.decode(h.file("manifest.json"))) as unknown);
  return { dataset_id: m.dataset_id, groups: m.groups.map((g) => ({ group_id: g.group_id, split: g.split })) };
}

export const generate: StagePlugin = createGenerateStage();
