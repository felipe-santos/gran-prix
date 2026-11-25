import { canonicalJson } from "@gran-prix/contracts";
import {
  NodeFeaturesSetReader,
  SnapshotSetReader,
  buildNodeLabels,
  labelPageExtraction,
  labelPageReadability,
  type ExtractionLabelParams,
  type NodeLabelsDoc,
  type PageInput,
} from "@gran-prix/labels";
import { defineStage, type StageContext, type StageOutputs, type StagePlugin } from "../../stage.js";
import type { ArtifactHandle } from "../../store.js";
import { DEFUDDLE_SWITCHES, defuddleDigest, defuddleVersion, runDefuddle, type DefuddleSwitches } from "./defuddle.js";
import {
  DEFAULT_ROUTER_TABLE,
  FALLBACK_ORDER,
  PAGE_TYPES,
  predictPageType,
  type ExtractorChoice,
  type PageType,
} from "./router-rules.js";
import { runTrafilatura, sidecarDigest, type TrafilaturaOptions } from "./trafilatura.js";

/**
 * Baseline labelers (E2.7, protocol section 7): Trafilatura (B2), Defuddle (B3) and the page-type router (B4) as
 * `label` stages with the same ports as `label.heuristic` (snapshots + features in, NodeLabelsSet out), so their
 * output goes straight into evaluate's `label_baselines` (name the systems with `params.label_baseline.names`: all of
 * them are `kind: "heuristic"`). Each page's flattened html is the extractor's input; the extractor's TEXT is aligned
 * back to element ids by the DP of `@gran-prix/labels` (Readability's alignment, `labelPageExtraction`). Coverage is
 * recorded per page (`alignment` of every document).
 *
 * Scoring a baseline: protocol 7 says low alignment coverage is scored anyway and reported, never dropped in the
 * baseline's favour, so pipelines that feed evaluate set `min_coverage: 0`. The default (0.9) is the labeling
 * behaviour of `label.heuristic` (a page under it is an abstention).
 */

const labelsPath = (doc: { snapshot_id: string }): string => `labels/${doc.snapshot_id.slice("sha256:".length, "sha256:".length + 12)}.json`;

function labelsSet(docs: readonly NodeLabelsDoc[]): StageOutputs {
  const files: Record<string, string> = {};
  for (const d of docs) files[labelsPath(d)] = `${canonicalJson(d)}\n`;
  return { labels: { files } };
}

interface Page extends PageInput {
  name: string;
}

/** Pairs every NodeFeatures with its snapshot and loads the flattened HTML (same join as the `label.*` stages). */
function pages(ctx: StageContext): Page[] {
  const snaps = new SnapshotSetReader(ctx.inputs["snapshots"] as ArtifactHandle);
  const feats = new NodeFeaturesSetReader(ctx.inputs["features"] as ArtifactHandle);
  const entries = new Map(snaps.entries().map((e) => [e.snapshot_id, e]));
  const featureEntries = feats.entries();
  if (featureEntries.length === 0) throw new Error("the features set holds no NodeFeatures document");
  return featureEntries.map((fe) => {
    const se = entries.get(fe.snapshot_id);
    if (!se) throw new Error(`features ${fe.features_id} refer to snapshot ${fe.snapshot_id}, which is not in the snapshot set`);
    const snapshot = snaps.snapshot(se);
    return { name: snapshot.page.url_key, snapshot, features: feats.features(fe), html: snaps.html(se) };
  });
}

const PORTS = {
  inputs: [
    { name: "snapshots", type: "SnapshotSet" },
    { name: "features", type: "NodeFeaturesSet" },
  ],
  outputs: [{ name: "labels", type: "NodeLabelsSet" }],
} as const;

const SHARED_PROPS = {
  confidence: { type: "number", minimum: 0, maximum: 1, description: "P(label correct) stamped on the labels (default 0.7)." },
  min_coverage: {
    type: "number",
    minimum: 0,
    maximum: 1,
    description: "Alignment coverage under which a page's labels are discarded (default 0.9). 0 = score every page, an empty output drops every unit (what baseline scoring needs).",
  },
  fuzzy: { type: "boolean", description: "Also keep units rescued by the order-free 2/3 rule (default false)." },
  h1_title: { type: "boolean", description: "Apply the h1-matches-title rule (default true; the same post-step Readability gets)." },
} as const;

function sharedParams(p: Readonly<Record<string, unknown>>): ExtractionLabelParams {
  return {
    ...(typeof p["confidence"] === "number" ? { confidence: p["confidence"] } : {}),
    ...(typeof p["min_coverage"] === "number" ? { min_coverage: p["min_coverage"] } : {}),
    ...(typeof p["fuzzy"] === "boolean" ? { fuzzy: p["fuzzy"] } : {}),
    ...(typeof p["h1_title"] === "boolean" ? { h1_title: p["h1_title"] } : {}),
  };
}

const alignmentOf = (d: NodeLabelsDoc): { discarded: boolean; status: string; coverage: number } => d["alignment"] as { discarded: boolean; status: string; coverage: number };

function logDiscarded(ctx: StageContext, name: string, d: NodeLabelsDoc): void {
  const a = alignmentOf(d);
  if (a.discarded) ctx.log(`${name}: labels discarded (${a.status}, alignment coverage ${(100 * a.coverage).toFixed(1)}%)`);
}

const TRAF_PROPS = {
  mode: { enum: ["precision", "default", "recall"], description: "Trafilatura mode: favor_precision / library default / favor_recall (default recall, as protocol 5.2; B2 tries the three in dev)." },
  include_tables: { type: "boolean", description: "Keep table text (default true, the library's)." },
  include_comments: { type: "boolean", description: "Keep comment sections / forum replies (default true, the library's)." },
  no_fallback: { type: "boolean", description: "Skip Trafilatura's internal readability/justext fallbacks (default false)." },
} as const;

function trafOptions(p: Readonly<Record<string, unknown>>, fallbackMode: TrafilaturaOptions["mode"]): TrafilaturaOptions {
  return {
    mode: (p["mode"] as TrafilaturaOptions["mode"]) ?? fallbackMode,
    ...(typeof p["include_tables"] === "boolean" ? { include_tables: p["include_tables"] } : {}),
    ...(typeof p["include_comments"] === "boolean" ? { include_comments: p["include_comments"] } : {}),
    ...(typeof p["no_fallback"] === "boolean" ? { no_fallback: p["no_fallback"] } : {}),
  };
}

/** Trafilatura over a batch of pages -> one labels document per page. */
function labelWithTrafilatura(ctx: StageContext | undefined, batch: readonly Page[], options: TrafilaturaOptions, shared: ExtractionLabelParams, extra?: (p: Page) => Record<string, unknown>): NodeLabelsDoc[] {
  const run = runTrafilatura(batch.map((p, i) => ({ key: String(i), html: p.html, url: p.snapshot.page.final_url })), options);
  return batch.map((page, i) => {
    const r = run.results[i];
    if (r?.error) ctx?.log(`${page.name}: trafilatura failed (${r.error}); treated as empty output`);
    return labelPageExtraction(
      page,
      { text: r?.text ?? null },
      { id: `trafilatura@${run.version}:${run.options.mode}`, params: { tool: "trafilatura", version: run.version, options: run.options }, extra: { extraction: { tool: "trafilatura", version: run.version, options: run.options, error: r?.error ?? null }, ...extra?.(page) } },
      shared,
    );
  });
}

async function labelWithDefuddle(page: Page, switches: DefuddleSwitches, shared: ExtractionLabelParams, extra?: Record<string, unknown>): Promise<NodeLabelsDoc> {
  const out = await runDefuddle(page.html, page.snapshot.page.final_url, switches);
  const version = defuddleVersion();
  return labelPageExtraction(
    page,
    { text: out.text, title: out.title },
    { id: `defuddle@${version}`, params: { tool: "defuddle", version, switches }, extra: { extraction: { tool: "defuddle", version, switches, error: out.error }, ...extra } },
    shared,
  );
}

/** `ts:label.trafilatura@1.0.0`: Trafilatura (Python sidecar) on the flattened html; its text is aligned to element ids. */
export const labelTrafilatura: StagePlugin = defineStage(
  {
    kind: "label",
    impl: "ts:label.trafilatura@1.0.0",
    inputs: [...PORTS.inputs],
    outputs: [...PORTS.outputs],
    params_schema: { type: "object", properties: { ...TRAF_PROPS, ...SHARED_PROPS }, additionalProperties: false },
    runtime: "node",
    determinism: "pure",
    map_over: "group",
  },
  (ctx) => {
    const docs = labelWithTrafilatura(ctx, pages(ctx), trafOptions(ctx.params, "recall"), sharedParams(ctx.params));
    docs.forEach((d, i) => logDiscarded(ctx, `page ${i}`, d));
    return labelsSet(docs);
  },
);

/** `ts:label.defuddle@1.0.0`: Defuddle on jsdom (network off); its text is aligned to element ids (its output keeps no `data-gp-id`). */
export const labelDefuddle: StagePlugin = defineStage(
  {
    kind: "label",
    impl: "ts:label.defuddle@1.0.0",
    inputs: [...PORTS.inputs],
    outputs: [...PORTS.outputs],
    params_schema: {
      type: "object",
      properties: {
        switches: {
          type: "object",
          properties: Object.fromEntries(DEFUDDLE_SWITCHES.map((k) => [k, { type: "boolean", description: `Defuddle option ${k} (library default true).` }])),
          additionalProperties: false,
          description: "Defuddle options to override: the default run is `{}`; the protocol's one variant is {removeLowScoring: false}. `useAsync` is always false (no network).",
        },
        ...SHARED_PROPS,
      },
      additionalProperties: false,
    },
    runtime: "node",
    determinism: "pure",
    map_over: "group",
  },
  async (ctx) => {
    const switches = (ctx.params["switches"] ?? {}) as DefuddleSwitches;
    const docs: NodeLabelsDoc[] = [];
    for (const page of pages(ctx)) {
      const d = await labelWithDefuddle(page, switches, sharedParams(ctx.params));
      logDiscarded(ctx, page.name, d);
      docs.push(d);
    }
    return labelsSet(docs);
  },
);

const choiceSchema = {
  type: "object",
  required: ["extractor"],
  properties: { extractor: { enum: ["trafilatura", "defuddle", "readability"] }, mode: { enum: ["precision", "default", "recall"], description: "Trafilatura only." } },
  additionalProperties: false,
} as const;

/** Alignment coverage the router needs before it trusts an extractor's output (fixed; independent of `min_coverage`). */
const FALLBACK_COVERAGE = 0.9;

/** Usable = the extractor returned text and the page explains at least 90% of it. With no usable extractor the first choice stands. */
export function usable(d: NodeLabelsDoc): boolean {
  const a = d["alignment"] as { status: string; coverage: number; output_chars?: number };
  return a.status !== "no-article" && a.status !== "no-output" && a.coverage >= FALLBACK_COVERAGE && (a.output_chars ?? 1) > 0;
}

const choiceKey = (c: ExtractorChoice): string => (c.extractor === "trafilatura" ? `trafilatura:${c.mode ?? "default"}` : c.extractor);

/**
 * `ts:label.router@1.0.0`: ONE extractor per page, chosen by page type (B4). `type_from: "predicted"` (default) takes the
 * type from JSON-LD `@type`, `og:type` and URL rules fixed in code (`router-rules.ts`); `"category"` takes the corpus
 * category of the snapshot (the oracle type of B4). `table` overrides the extractor of listed types (the default table
 * is a priori; an oracle router passes the best of B1-B3 per category chosen in dev). When the chosen extractor's labels
 * are discarded (empty output, or alignment under `min_coverage`) the router falls back, in a fixed order, to the first
 * of Trafilatura(default), Defuddle, Readability not yet tried. Each document records `router`: type, signal, choice and fallbacks.
 */
export const labelRouter: StagePlugin = defineStage(
  {
    kind: "label",
    impl: "ts:label.router@1.0.0",
    inputs: [...PORTS.inputs],
    outputs: [...PORTS.outputs],
    params_schema: {
      type: "object",
      properties: {
        type_from: { enum: ["predicted", "category"], description: "Page type source: rules on JSON-LD/og:type/URL (default) or the snapshot's corpus category (oracle)." },
        table: {
          type: "object",
          propertyNames: { enum: [...PAGE_TYPES] },
          additionalProperties: choiceSchema,
          description: "Extractor per page type, overriding the a priori default table (unlisted types keep the default).",
        },
        fallback: { type: "boolean", description: "Fall back to the next extractor when the chosen one's labels are discarded (default true)." },
        ...SHARED_PROPS,
      },
      additionalProperties: false,
    },
    runtime: "node",
    determinism: "pure",
    map_over: "group",
  },
  async (ctx) => {
    const p = ctx.params;
    const shared = sharedParams(p);
    const table: Record<string, ExtractorChoice> = { ...DEFAULT_ROUTER_TABLE, ...((p["table"] ?? {}) as Record<string, ExtractorChoice>) };
    const useFallback = p["fallback"] !== false;
    const fromCategory = p["type_from"] === "category";
    const all = pages(ctx);
    const plan = all.map((page) => {
      const pg = page.snapshot.page;
      const pred = fromCategory
        ? { type: pg.category as PageType, signal: "category" as const, evidence: pg.category }
        : predictPageType({ url: pg.final_url, og_type: pg.og_type, jsonld_types: pg.jsonld_types });
      const choice = table[pred.type] ?? table["unknown"] ?? (DEFAULT_ROUTER_TABLE.unknown as ExtractorChoice);
      return { page, pred, choice };
    });

    // First choices that are Trafilatura run as one batch per mode (one sidecar start per mode, not per page).
    const traf = new Map<string, NodeLabelsDoc>(); // `${page index}|${mode}` -> labels
    const modes = new Set(plan.filter((x) => x.choice.extractor === "trafilatura").map((x) => x.choice.mode ?? "default"));
    for (const mode of modes) {
      const idx = plan.flatMap((x, i) => (x.choice.extractor === "trafilatura" && (x.choice.mode ?? "default") === mode ? [i] : []));
      const docs = labelWithTrafilatura(ctx, idx.map((i) => (plan[i] as { page: Page }).page), { mode }, shared);
      idx.forEach((i, k) => traf.set(`${i}|${mode}`, docs[k] as NodeLabelsDoc));
    }
    const tryChoice = async (i: number, c: ExtractorChoice): Promise<NodeLabelsDoc> => {
      const page = (plan[i] as { page: Page }).page;
      if (c.extractor === "trafilatura") {
        const hit = traf.get(`${i}|${c.mode ?? "default"}`);
        return hit ?? (labelWithTrafilatura(ctx, [page], { mode: c.mode ?? "default" }, shared)[0] as NodeLabelsDoc);
      }
      if (c.extractor === "defuddle") return labelWithDefuddle(page, {}, shared);
      return labelPageReadability(page, shared);
    };

    const out: NodeLabelsDoc[] = [];
    for (const [i, { page, pred, choice }] of plan.entries()) {
      const tried = [choiceKey(choice)];
      const first = await tryChoice(i, choice);
      let used = choice;
      let doc = first;
      if (useFallback) {
        for (const next of FALLBACK_ORDER) {
          if (usable(doc)) break;
          if (tried.includes(choiceKey(next))) continue;
          tried.push(choiceKey(next));
          const d = await tryChoice(i, next);
          if (usable(d)) {
            used = next;
            doc = d;
          }
        }
      }
      logDiscarded(ctx, page.name, doc);
      out.push(
        buildNodeLabels({
          snapshot_id: page.snapshot.snapshot_id,
          labeler: {
            id: `router@1.0.0:${fromCategory ? "category" : "predicted"}`,
            kind: "heuristic",
            params: { type_from: fromCategory ? "category" : "predicted", table, fallback: useFallback, fallback_order: FALLBACK_ORDER, ...shared },
          },
          items: doc.items,
          n_candidates: doc.coverage.n_candidates,
          extra: {
            alignment: doc["alignment"],
            router: { type: pred.type, type_signal: pred.signal, evidence: pred.evidence, chosen: choiceKey(choice), used: choiceKey(used), tried },
          },
        }),
      );
    }
    return labelsSet(out);
  },
);

export const BASELINE_LABEL_STAGES: readonly StagePlugin[] = [
  { ...labelTrafilatura, toolDigests: () => ({ trafilatura: sidecarDigest() }) },
  { ...labelDefuddle, toolDigests: () => ({ defuddle: defuddleDigest() }) },
  { ...labelRouter, toolDigests: () => ({ trafilatura: sidecarDigest(), defuddle: defuddleDigest() }) },
];

