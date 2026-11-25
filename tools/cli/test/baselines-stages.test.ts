// label.trafilatura / label.defuddle / label.router through the real runner, on the synthetic fixture corpus
// (global setup). Trafilatura needs the Python sidecar (tools/baselines/.pylibs, gitignored): those tests are
// skipped, loudly, when it is not installed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate, type NodeLabels, type PageSnapshot, type PipelineSpec, type StageKindSpec } from "@gran-prix/contracts";
import { afterAll, describe, expect, inject, it } from "vitest";
import { StageRegistry, checkPipeline, runPipeline, type StagePlugin } from "../src/index.js";
import { ALL_STAGES } from "../src/stages/index.js";
import { SNAP, corpusExternals, labelDocs, sidecarAvailable } from "./baselines-helpers.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

const corpus = inject("corpusDir");
const HAVE_PY = sidecarAvailable();
if (!HAVE_PY) console.warn("[baselines] Trafilatura sidecar not installed (tools/baselines/requirements.txt): the Trafilatura/router tests are SKIPPED");
const withPython = HAVE_PY ? describe : describe.skip;

const ENV = { format: "gran-prix.pipeline-spec", format_version: "1.0.0" } as const;
type Doc = NodeLabels & Record<string, unknown>;

function stageSpec(ext: PipelineSpec["externals"], stages: Array<{ id: string; impl: string; params?: Record<string, unknown> }>): PipelineSpec {
  return { ...ENV, name: "baselines", externals: ext as NonNullable<PipelineSpec["externals"]>, stages: stages.map((s) => ({ id: s.id, kind: "label", impl: s.impl, params: s.params ?? {}, inputs: SNAP })) };
}

async function labelsOf(stages: Array<{ id: string; impl: string; params?: Record<string, unknown> }>): Promise<{ dataDir: string; docs: Record<string, Map<string, Doc>>; run: Awaited<ReturnType<typeof runPipeline>> }> {
  const dataDir = tmpDir();
  const run = await runPipeline(stageSpec(corpusExternals(corpus, dataDir), stages), { dataDir, plugins: ALL_STAGES as StagePlugin[], budgetUSD: 0 });
  expect(run.stages.map((s) => s.error).filter(Boolean)).toEqual([]);
  const docs: Record<string, Map<string, Doc>> = {};
  for (const s of run.stages) docs[s.stageId] = labelDocs(dataDir, s.outputs["labels"] as string, corpus);
  return { dataDir, docs, run };
}

const snapshotOf = (name: string): PageSnapshot => {
  const idx = JSON.parse(readFileSync(join(corpus, "index.json"), "utf8")) as Array<{ name: string; hex: string }>;
  return JSON.parse(readFileSync(join(corpus, "snapshot-set", "snapshots", `${(idx.find((e) => e.name === name) as { hex: string }).hex}.json`), "utf8")) as PageSnapshot;
};

/** Char-weighted F1 of the labels' keep (main/support) against the live-page truth of the fixture (keep = main + support). */
function f1Against(name: string, d: NodeLabels): number {
  const snap = snapshotOf(name);
  const truth = JSON.parse(readFileSync(join(corpus, "browser-truth", `${name}.json`), "utf8")) as Array<string | null>;
  let tp = 0, fp = 0, fn = 0;
  for (const it of d.items) {
    const t = truth[it.unit_id];
    if (t === null || t === undefined) continue;
    const w = snap.nodes[it.unit_id]?.own_text_len ?? 0;
    const pos = t !== "noise";
    const pred = it.y !== 2;
    if (pos && pred) tp += w;
    else if (pos) fn += w;
    else if (pred) fp += w;
  }
  return (2 * tp) / (2 * tp + fp + fn);
}

const alignment = (d: Doc): { status: string; discarded: boolean; coverage: number; min_coverage: number; output_chars: number } => d["alignment"] as never;

const SCORE = { min_coverage: 0 }; // baseline scoring: never discard a page (protocol 7)

describe("the baseline label stages are registered", () => {
  const registry = new StageRegistry(ALL_STAGES);
  const impls = ["ts:label.trafilatura@1.0.0", "ts:label.defuddle@1.0.0", "ts:label.router@1.0.0"];

  it("with the ports of label.heuristic and a closed params schema", () => {
    const heuristic = registry.get("ts:label.heuristic@1.0.0")?.spec as StageKindSpec;
    for (const impl of impls) {
      const spec = registry.get(impl)?.spec as StageKindSpec;
      expect(spec, impl).toBeDefined();
      expect(spec.kind).toBe("label");
      expect(spec.inputs).toEqual(heuristic.inputs);
      expect(spec.outputs).toEqual(heuristic.outputs);
      expect((spec.params_schema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
      expect(Object.keys((spec.params_schema as { properties: object }).properties)).toEqual(expect.arrayContaining(["confidence", "min_coverage", "fuzzy", "h1_title"]));
    }
  });

  it("and a pipeline that wires them into evaluate's label_baselines checks", () => {
    const spec: PipelineSpec = {
      ...ENV,
      name: "check",
      externals: { snapshots: { type: "SnapshotSet", id: `sha256:${"a".repeat(64)}` }, features: { type: "NodeFeaturesSet", id: `sha256:${"b".repeat(64)}` } },
      stages: impls.map((impl, i) => ({ id: `s${i}`, kind: "label" as const, impl, params: {}, inputs: SNAP })),
    };
    expect(checkPipeline(spec, registry)).toMatchObject({ ok: true });
  });
});

describe("label.defuddle", () => {
  it("emits contract-valid 3-class labels over the units that own text and reports alignment coverage", async () => {
    const { docs } = await labelsOf([{ id: "defu", impl: "ts:label.defuddle@1.0.0", params: SCORE }]);
    const d = docs["defu"] as Map<string, Doc>;
    expect([...d.keys()].sort()).toEqual(["article-1", "article-2", "docs-1", "forum-1", "landing-1", "product-1"]);
    for (const [name, doc] of d) {
      expect(validate("node-labels", doc).issues, name).toEqual([]);
      expect(doc.labeler.kind).toBe("heuristic");
      expect(doc.labeler.id).toMatch(/^defuddle@\d+\.\d+\.\d+$/);
      expect(doc.coverage.n_labeled, name).toBe(doc.coverage.n_candidates);
      expect(doc.items.every((i) => i.y === 0 || i.y === 2)).toBe(true);
      expect(doc.items.every((i) => i.source === "heuristic" || i.source === "rule")).toBe(true);
      expect(alignment(doc)).toMatchObject({ status: "ok", discarded: false });
      expect(alignment(doc).coverage, name).toBeGreaterThanOrEqual(0.9);
      expect((doc["extraction"] as { tool: string; error: unknown }).tool).toBe("defuddle");
    }
  });

  it("keeps the article and drops the chrome of an article page", async () => {
    const { docs } = await labelsOf([{ id: "defu", impl: "ts:label.defuddle@1.0.0", params: SCORE }]);
    const a1 = (docs["defu"] as Map<string, Doc>).get("article-1") as Doc;
    expect(f1Against("article-1", a1)).toBeGreaterThan(0.8);
    expect(a1.items.some((i) => i.y === 2)).toBe(true);
    expect(a1.items.some((i) => i.y === 0)).toBe(true);
  });

  it("switches are params: they change the labeler params hash", async () => {
    const { docs } = await labelsOf([
      { id: "a", impl: "ts:label.defuddle@1.0.0", params: SCORE },
      { id: "b", impl: "ts:label.defuddle@1.0.0", params: { ...SCORE, switches: { removeLowScoring: false } } },
    ]);
    const get = (id: string) => (docs[id] as Map<string, Doc>).get("docs-1") as Doc;
    expect(get("b").labeler.params_sha256).not.toBe(get("a").labeler.params_sha256);
    expect((get("b")["extraction"] as { switches: unknown }).switches).toEqual({ removeLowScoring: false });
  });

  it("is deterministic: a second run is a 100% cache hit and another data dir gives the same ids", async () => {
    const dataDir = tmpDir();
    const spec = stageSpec(corpusExternals(corpus, dataDir), [{ id: "defu", impl: "ts:label.defuddle@1.0.0", params: SCORE }]);
    const first = await runPipeline(spec, { dataDir, plugins: ALL_STAGES as StagePlugin[], budgetUSD: 0 });
    const second = await runPipeline(spec, { dataDir, plugins: ALL_STAGES as StagePlugin[], budgetUSD: 0 });
    expect(second.counts).toMatchObject({ ran: 0, cached: 1 });
    expect(second.stages[0]?.outputs).toEqual(first.stages[0]?.outputs);
    const other = tmpDir();
    const third = await runPipeline(stageSpec(corpusExternals(corpus, other), [{ id: "defu", impl: "ts:label.defuddle@1.0.0", params: SCORE }]), { dataDir: other, plugins: ALL_STAGES as StagePlugin[], budgetUSD: 0 });
    expect(third.stages[0]?.outputs).toEqual(first.stages[0]?.outputs);
  });
});

withPython("label.trafilatura (Python sidecar)", () => {
  it("emits contract-valid labels with the tool version and options recorded, coverage reported per page", async () => {
    const { docs } = await labelsOf([{ id: "traf", impl: "ts:label.trafilatura@1.0.0", params: SCORE }]);
    const d = docs["traf"] as Map<string, Doc>;
    expect(d.size).toBe(6);
    for (const [name, doc] of d) {
      expect(validate("node-labels", doc).issues, name).toEqual([]);
      expect(doc.labeler.kind).toBe("heuristic");
      expect(doc.labeler.id).toMatch(/^trafilatura@\d+\.\d+\.\d+:recall$/); // default mode = favor_recall (protocol 5.2)
      expect(doc.coverage.n_labeled).toBe(doc.coverage.n_candidates);
      expect(typeof alignment(doc).coverage).toBe("number");
      expect((doc["extraction"] as { options: { mode: string } }).options.mode).toBe("recall");
    }
    expect(f1Against("article-1", d.get("article-1") as Doc)).toBeGreaterThan(0.8);
    expect(f1Against("forum-1", d.get("forum-1") as Doc)).toBeGreaterThan(0.8);
  });

  it("a page whose text the extractor did not take from the DOM shows up as LOW coverage (product-1: JSON-LD text), kept when scoring, discarded when labeling", async () => {
    const { docs } = await labelsOf([
      { id: "score", impl: "ts:label.trafilatura@1.0.0", params: SCORE },
      { id: "label", impl: "ts:label.trafilatura@1.0.0", params: {} },
    ]);
    const scored = (docs["score"] as Map<string, Doc>).get("product-1") as Doc;
    const labeled = (docs["label"] as Map<string, Doc>).get("product-1") as Doc;
    expect(alignment(scored).coverage).toBeLessThan(0.9);
    expect(alignment(scored).discarded).toBe(false);
    expect(scored.items.length).toBe(scored.coverage.n_candidates);
    expect(alignment(labeled)).toMatchObject({ discarded: true, status: "low-coverage" });
    expect(labeled.items).toEqual([]);
    expect(validate("node-labels", labeled).issues).toEqual([]);
  });

  it("mode and options are params: they change the labeler id and the labels_id", async () => {
    const { docs } = await labelsOf([
      { id: "p", impl: "ts:label.trafilatura@1.0.0", params: { ...SCORE, mode: "precision" } },
      { id: "d", impl: "ts:label.trafilatura@1.0.0", params: { ...SCORE, mode: "default", include_comments: false } },
    ]);
    const p = (docs["p"] as Map<string, Doc>).get("forum-1") as Doc;
    const d = (docs["d"] as Map<string, Doc>).get("forum-1") as Doc;
    expect(p.labeler.id).toMatch(/:precision$/);
    expect(d.labeler.id).toMatch(/:default$/);
    expect((d["extraction"] as { options: { include_comments: boolean } }).options.include_comments).toBe(false);
    expect(p.labels_id).not.toBe(d.labels_id);
  });

  it("second run is a cache hit; the sidecar digest is part of the tool versions of the receipt", async () => {
    const dataDir = tmpDir();
    const spec = stageSpec(corpusExternals(corpus, dataDir), [{ id: "traf", impl: "ts:label.trafilatura@1.0.0", params: SCORE }]);
    const plugin = ALL_STAGES.find((p) => p.spec.impl === "ts:label.trafilatura@1.0.0") as StagePlugin;
    expect(Object.keys(plugin.toolDigests?.() ?? {})).toEqual(["trafilatura"]);
    const first = await runPipeline(spec, { dataDir, plugins: ALL_STAGES as StagePlugin[], budgetUSD: 0 });
    const second = await runPipeline(spec, { dataDir, plugins: ALL_STAGES as StagePlugin[], budgetUSD: 0 });
    expect(first.counts).toMatchObject({ ran: 1, cached: 0 });
    expect(second.counts).toMatchObject({ ran: 0, cached: 1 });
  });
});

withPython("label.router", () => {
  it("predicted: type from JSON-LD / og:type / URL, recorded per page with the extractor chosen and used", async () => {
    const { docs } = await labelsOf([{ id: "rp", impl: "ts:label.router@1.0.0", params: SCORE }]);
    const d = docs["rp"] as Map<string, Doc>;
    const r = (n: string) => (d.get(n) as Doc)["router"] as { type: string; type_signal: string; chosen: string; used: string; tried: string[] };
    for (const [name, doc] of d) {
      expect(validate("node-labels", doc).issues, name).toEqual([]);
      expect(doc.labeler.id).toBe("router@1.0.0:predicted");
      expect(doc.labeler.kind).toBe("heuristic");
    }
    expect(r("article-1")).toMatchObject({ type: "article", type_signal: "jsonld", chosen: "trafilatura:default" });
    expect(r("article-2")).toMatchObject({ type: "article", type_signal: "og:type" });
    expect(r("product-1")).toMatchObject({ type: "product", type_signal: "jsonld", chosen: "trafilatura:recall" });
    expect(r("forum-1")).toMatchObject({ type: "unknown", type_signal: "none" }); // file URLs carry no type
  });

  it("falls back when the pick is unusable: product-1 (Trafilatura reads JSON-LD text) is answered by Defuddle and scores far better", async () => {
    const { docs } = await labelsOf([
      { id: "traf", impl: "ts:label.trafilatura@1.0.0", params: SCORE },
      { id: "rc", impl: "ts:label.router@1.0.0", params: { ...SCORE, type_from: "category" } },
      { id: "nofb", impl: "ts:label.router@1.0.0", params: { ...SCORE, type_from: "category", fallback: false } },
    ]);
    const rc = (docs["rc"] as Map<string, Doc>).get("product-1") as Doc;
    const route = rc["router"] as { type: string; type_signal: string; chosen: string; used: string; tried: string[] };
    expect(route).toMatchObject({ type: "product", type_signal: "category", chosen: "trafilatura:recall", used: "defuddle" });
    expect(route.tried).toEqual(["trafilatura:recall", "trafilatura:default", "defuddle"]);
    expect(f1Against("product-1", rc)).toBeGreaterThan(f1Against("product-1", (docs["traf"] as Map<string, Doc>).get("product-1") as Doc) + 0.3);
    const nofb = (docs["nofb"] as Map<string, Doc>).get("product-1") as Doc;
    expect((nofb["router"] as { used: string; tried: string[] }).used).toBe("trafilatura:recall");
    expect((nofb["router"] as { tried: string[] }).tried).toEqual(["trafilatura:recall"]);
    // pages whose pick is usable are not touched by the fallback
    const art = (docs["rc"] as Map<string, Doc>).get("article-1") as Doc;
    expect((art["router"] as { tried: string[] }).tried).toEqual(["trafilatura:default"]);
  });

  it("oracle type + a table override: the extractor of a type is a param, the others keep the a priori default", async () => {
    const { docs } = await labelsOf([{ id: "rt", impl: "ts:label.router@1.0.0", params: { ...SCORE, type_from: "category", table: { forum: { extractor: "defuddle" }, article: { extractor: "readability" } } } }]);
    const d = docs["rt"] as Map<string, Doc>;
    const used = (n: string) => ((d.get(n) as Doc)["router"] as { used: string }).used;
    expect(used("forum-1")).toBe("defuddle");
    expect(used("article-1")).toBe("readability");
    expect(used("docs-1")).toBe("trafilatura:default");
    expect(used("landing-1")).toBe("trafilatura:recall");
    expect((d.get("forum-1") as Doc).labeler.params_sha256).not.toBe(
      (await labelsOf([{ id: "rt2", impl: "ts:label.router@1.0.0", params: { ...SCORE, type_from: "category" } }])).docs["rt2"]?.get("forum-1")?.labeler.params_sha256,
    );
  });
});
