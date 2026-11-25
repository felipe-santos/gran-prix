// Label + dataset stages through the real runner: temp data dir, inputs pre-loaded into the store as
// externals (what a collect + extract run would have produced), second run 100% cache hit.
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assignSplit, validate, type DatasetManifest, type DatasetRow, type NodeLabels, type PipelineSpec, type StageKindSpec } from "@gran-prix/contracts";
import { afterAll, describe, expect, it, inject } from "vitest";
import {
  ArtifactStore,
  StageRegistry,
  checkPipeline,
  dataPaths,
  runPipeline,
  type StagePlugin,
} from "../src/index.js";
import { ALL_STAGES } from "../src/stages/index.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

const corpus = inject("corpusDir");
const PAGES = ["article-1", "article-2", "docs-1", "forum-1", "landing-1", "product-1"];
const HUMAN_PAGES = ["article-1", "docs-1", "forum-1"];

function tree(sub: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(corpus, sub, rel), { withFileTypes: true })) {
      const p = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else out[p] = new Uint8Array(readFileSync(join(corpus, sub, p)));
    }
  };
  walk("");
  return out;
}

/** Loads the corpus into the store of `dataDir` and returns the externals that pin it by id. */
function externals(dataDir: string): NonNullable<PipelineSpec["externals"]> {
  mkdirSync(dataPaths(dataDir).artifacts, { recursive: true });
  const store = new ArtifactStore(dataPaths(dataDir).artifacts);
  const schema = JSON.parse(readFileSync(join(corpus, "schema.json"), "utf8")) as unknown;
  return {
    snapshots: { type: "SnapshotSet", id: store.putFiles("SnapshotSet", tree("snapshot-set")) },
    features: { type: "NodeFeaturesSet", id: store.putFiles("NodeFeaturesSet", tree("features-set")) },
    schema: { type: "FeatureSchema", id: store.putJson("FeatureSchema", schema) },
  };
}

const truthPages = (): Array<{ url_contains: string; rules: unknown[] }> =>
  HUMAN_PAGES.map((n) => ({
    url_contains: `${n}.html`,
    rules: (JSON.parse(readFileSync(join(corpus, "truth", `${n}.json`), "utf8")) as { rules: unknown[] }).rules,
  }));

/** A seed whose split puts a page with human labels in test, and something in train and val. */
function seedFor(): string {
  const groupKeys = (names: string[]) => names.map((n) => (n.startsWith("article-") ? "news.example" : `${n}.example`));
  for (let i = 0; i < 500; i++) {
    const seed = `s${i}`;
    const split = (n: string) => assignSplit(seed, groupKeys([n])[0] as string).split;
    if (HUMAN_PAGES.some((n) => split(n) === "test") && PAGES.some((n) => split(n) === "train") && PAGES.some((n) => split(n) === "val")) return seed;
  }
  throw new Error("no seed");
}
const SEED = seedFor();

const SNAP = { snapshots: { external: "snapshots" }, features: { external: "features" } };
function spec(ext: PipelineSpec["externals"], over: { heur?: Record<string, unknown>; seed?: string } = {}): PipelineSpec {
  return {
    format: "gran-prix.pipeline-spec",
    format_version: "1.0.0",
    name: "labels-dataset",
    externals: ext as NonNullable<PipelineSpec["externals"]>,
    stages: [
      { id: "heur", kind: "label", impl: "ts:label.heuristic@1.0.0", params: over.heur ?? {}, inputs: SNAP },
      { id: "truth", kind: "label", impl: "ts:label.truth@1.0.0", params: { pages: truthPages() }, inputs: SNAP },
      {
        id: "merged",
        kind: "label",
        impl: "ts:label.merge@1.0.0",
        params: {},
        inputs: { layers: [{ stage: "heur", output: "labels" }, { stage: "truth", output: "labels" }] },
      },
      {
        id: "data",
        kind: "dataset",
        impl: "ts:dataset.jsonl@1.0.0",
        params: { split: { seed: over.seed ?? SEED } },
        inputs: {
          features: { external: "features" },
          labels: { stage: "merged", output: "labels" },
          schema: { external: "schema" },
          snapshots: { external: "snapshots" },
        },
      },
    ],
  };
}

function counting(): { plugins: StagePlugin[]; calls: string[] } {
  const calls: string[] = [];
  const plugins = ALL_STAGES.map((p): StagePlugin => ({ spec: p.spec, run: (ctx) => (calls.push(ctx.stageId), p.run(ctx)) }));
  return { plugins, calls };
}

const rowsOf = (text: string): DatasetRow[] =>
  text === "" ? [] : text.trimEnd().split("\n").map((l) => JSON.parse(l) as DatasetRow);

describe("label + dataset stages", () => {
  it("are registered with the canonical ports of the registry and a valid pipeline checks", () => {
    const canonical = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", "..", "packages", "contracts", "fixtures", "valid", "pipeline-registry.json"), "utf8"),
    ) as StageKindSpec[];
    const registry = new StageRegistry(ALL_STAGES);
    for (const c of canonical.filter((k) => k.impl === "ts:label.heuristic@1.0.0" || k.impl === "ts:dataset.jsonl@1.0.0")) {
      const mine = registry.get(c.impl)?.spec as StageKindSpec;
      expect(mine, c.impl).toBeDefined();
      expect(mine.kind).toBe(c.kind);
      expect(mine.outputs).toEqual(c.outputs);
      // every canonical input is present, in order; the dataset stage adds one OPTIONAL input after them
      expect(mine.inputs.slice(0, c.inputs.length)).toEqual(c.inputs);
      expect(mine.inputs.slice(c.inputs.length).every((p) => p.optional === true)).toBe(true);
    }
    expect(registry.get("ts:label.truth@1.0.0")).toBeDefined();
    const dataDir = tmpDir();
    expect(checkPipeline(spec(externals(dataDir)), registry).ok).toBe(true);
  });

  it("label -> merge -> dataset: contract-valid output, domain split, human-only test, second run 100% cached", async () => {
    const dataDir = tmpDir();
    const ext = externals(dataDir);
    const { plugins, calls } = counting();
    const opts = { dataDir, plugins, budgetUSD: 0 };

    const first = await runPipeline(spec(ext), opts);
    expect(first.stages.map((s) => s.error).filter(Boolean)).toEqual([]);
    expect(first.ok).toBe(true);
    expect(first.counts).toMatchObject({ ran: 4, cached: 0, failed: 0 });
    expect(calls.sort()).toEqual(["data", "heur", "merged", "truth"]);

    const store = new ArtifactStore(dataPaths(dataDir).artifacts);
    const out = (id: string, port: string) => first.stages.find((s) => s.stageId === id)!.outputs[port] as `sha256:${string}`;

    // labels: one NodeLabels per page, aligned to the feature rows that own text
    const labelsHandle = store.handle(out("merged", "labels"), "NodeLabelsSet");
    const docs = labelsHandle.files().map((f) => JSON.parse(Buffer.from(labelsHandle.file(f)).toString("utf8")) as NodeLabels);
    expect(docs).toHaveLength(PAGES.length);
    for (const d of docs) expect(validate("node-labels", d).issues).toEqual([]);
    const sources = (d: NodeLabels) => new Set(d.items.map((i) => i.source));
    expect(docs.filter((d) => sources(d).has("human"))).toHaveLength(HUMAN_PAGES.length); // human pages carry human labels
    expect(docs.every((d) => d.labeler.kind === "merge" && d.labeler.inputs?.length === 2)).toBe(true); // heuristic + truth layers

    // dataset: manifest + 3 jsonl files, validates against the contracts
    const ds = store.handle(out("data", "dataset"), "Dataset");
    expect(ds.files().sort()).toEqual(["manifest.json", "test.jsonl", "train.jsonl", "val.jsonl"]);
    const manifest = JSON.parse(Buffer.from(ds.file("manifest.json")).toString("utf8")) as DatasetManifest;
    expect(validate("dataset-manifest", manifest).issues).toEqual([]);
    const rows = Object.fromEntries(
      (["train", "val", "test"] as const).map((s) => [s, rowsOf(Buffer.from(ds.file(`${s}.jsonl`)).toString("utf8"))]),
    ) as Record<"train" | "val" | "test", DatasetRow[]>;
    for (const s of ["train", "val", "test"] as const) {
      expect(rows[s].length, s).toBe(manifest.files[s].rows);
      for (const r of rows[s]) expect(validate("dataset-row", r).issues).toEqual([]);
    }
    expect(rows.test.length).toBeGreaterThan(0);
    expect(rows.test.every((r) => r.s === "human")).toBe(true);
    expect([...rows.train, ...rows.val].some((r) => r.s !== "human")).toBe(true);
    expect(manifest.split.salt).toBe(SEED);
    expect(manifest.label_projection?.keep_classes).toEqual(["main", "support"]);
    const keyToSplit = new Map<string, string>();
    for (const g of manifest.groups) {
      expect(keyToSplit.get(g.group_key) ?? g.split, g.group_key).toBe(g.split);
      keyToSplit.set(g.group_key, g.split);
    }
    expect(manifest.groups.filter((g) => g.group_key === "news.example")).toHaveLength(2);
    expect(first.stages.every((s) => s.costUSD === 0)).toBe(true);

    // second run: every stage is a cache hit, no stage code runs, ids are identical
    calls.length = 0;
    const second = await runPipeline(spec(ext), opts);
    expect(second.ok).toBe(true);
    expect(second.counts).toMatchObject({ ran: 0, cached: 4, failed: 0 });
    expect(calls).toEqual([]);
    expect(second.stages.map((s) => s.outputs)).toEqual(first.stages.map((s) => s.outputs));
  });

  it("the dataset id is the same in another data dir (deterministic stages)", async () => {
    const a = tmpDir();
    const b = tmpDir();
    const ra = await runPipeline(spec(externals(a)), { dataDir: a, plugins: ALL_STAGES });
    const rb = await runPipeline(spec(externals(b)), { dataDir: b, plugins: ALL_STAGES });
    const ds = (r: typeof ra) => r.stages.find((s) => s.stageId === "data")!.outputs["dataset"];
    expect(ds(ra)).toBeDefined();
    expect(ds(ra)).toBe(ds(rb));
  });

  it("changing a heuristic param re-runs the heuristic labeler and what is downstream, not the truth import", async () => {
    const dataDir = tmpDir();
    const ext = externals(dataDir);
    const { plugins, calls } = counting();
    const opts = { dataDir, plugins };
    await runPipeline(spec(ext), opts);
    calls.length = 0;
    const r = await runPipeline(spec(ext, { heur: { confidence: 0.6 } }), opts);
    expect(r.ok).toBe(true);
    expect(calls.sort()).toEqual(["data", "heur", "merged"]);
    const changed = await runPipeline(spec(ext, { seed: `${SEED}-2` }), opts);
    expect(changed.stages.find((s) => s.stageId === "data")!.status).toBe("ran");
  });

  it("the dataset stage says what is missing when it has no snapshots, and rejects bad params at validation", async () => {
    const dataDir = tmpDir();
    const ext = externals(dataDir);
    const s = spec(ext);
    const data = s.stages.find((x) => x.id === "data")!;
    delete (data.inputs as Record<string, unknown>)["snapshots"];
    const r = await runPipeline(s, { dataDir, plugins: ALL_STAGES });
    expect(r.ok).toBe(false);
    expect(r.stages.find((x) => x.stageId === "data")!.error).toMatch(/snapshots/);

    const bad = spec(ext);
    (bad.stages.find((x) => x.id === "data")!.params as Record<string, unknown>)["keep_classes"] = [];
    expect(checkPipeline(bad, new StageRegistry(ALL_STAGES)).ok).toBe(false);
    const noSeed = spec(ext);
    (noSeed.stages.find((x) => x.id === "data")!.params as Record<string, unknown>)["split"] = {};
    expect(checkPipeline(noSeed, new StageRegistry(ALL_STAGES)).ok).toBe(false);
  });

  it("heuristic-only pipeline: no paid call, and every page carries its alignment record", async () => {
    const dataDir = tmpDir();
    const ext = externals(dataDir);
    const s = spec(ext);
    const r = await runPipeline({ ...s, stages: s.stages.slice(0, 1) }, { dataDir, plugins: ALL_STAGES, budgetUSD: 0 });
    expect(r.ok).toBe(true);
    expect(r.stages[0]!.costUSD).toBe(0);
    const store = new ArtifactStore(dataPaths(dataDir).artifacts);
    const h = store.handle(r.stages[0]!.outputs["labels"] as `sha256:${string}`, "NodeLabelsSet");
    for (const f of h.files()) {
      const d = JSON.parse(Buffer.from(h.file(f)).toString("utf8")) as NodeLabels & { alignment: { status: string; coverage: number } };
      expect(d.alignment.status).toBe("ok");
      expect(d.alignment.coverage).toBeGreaterThanOrEqual(0.9);
    }
  });
});
