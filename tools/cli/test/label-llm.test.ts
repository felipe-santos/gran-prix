// ts:label.llm@1.0.0 through the real runner. No network, no key: the stage gets the REAL AnthropicTransport with an
// injected `fetch` that plays the API, and a sentinel key that must never reach any file the run writes.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assignSplit, validate, type NodeLabels, type PipelineSpec } from "@gran-prix/contracts";
import { AnthropicTransport, defaultFakeAnswer, type AnthropicTransportOptions, type LlmReport } from "@gran-prix/labels";
import { afterAll, describe, expect, it, inject } from "vitest";
import { ArtifactStore, StageRegistry, checkPipeline, dataPaths, runPipeline, type StagePlugin } from "../src/index.js";
import { ALL_STAGES } from "../src/stages/index.js";
import { LlmBudgetStopError, createLabelLlmStage } from "../src/stages/label-llm.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

const corpus = inject("corpusDir");
const SECRET = "sk-ant-api03-SENTINEL-do-not-leak-0123456789";
const PRICES = { input_usd_per_mtok: 3, output_usd_per_mtok: 15 }; // example prices for the test, not a claim about any model
const GUIDE = "# Guia\n\n## 1. As tres classes\n\nx\n\n## 2. Unidade\n\ny\n\n## 3. Regras\n\nz\n\n## 4. Categorias\n\nw\n\n## 5. Fora do prompt\n\nnope\n";
const GUIDE_SHA = createHash("sha256").update(GUIDE).digest("hex");

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

function externals(dataDir: string): NonNullable<PipelineSpec["externals"]> {
  mkdirSync(dataPaths(dataDir).artifacts, { recursive: true });
  const store = new ArtifactStore(dataPaths(dataDir).artifacts);
  return {
    snapshots: { type: "SnapshotSet", id: store.putFiles("SnapshotSet", tree("snapshot-set")) },
    features: { type: "NodeFeaturesSet", id: store.putFiles("NodeFeaturesSet", tree("features-set")) },
  };
}

/** The Anthropic API as a function: answers every BLOCKS line with a label, reports usage, counts the calls. */
function fakeApi(): { fetch: NonNullable<AnthropicTransportOptions["fetch"]>; calls: number } {
  const state = { calls: 0 };
  const fn = (_url: string, init: { headers: Record<string, string>; body: string }) => {
    expect(init.headers["x-api-key"]).toBe(SECRET);
    state.calls++;
    const body = JSON.parse(init.body) as { messages: Array<{ content: string }>; system: Array<{ text: string }> };
    const text = defaultFakeAnswer(body.messages[0]!.content);
    const usage = {
      input_tokens: Math.ceil(body.messages[0]!.content.length / 4),
      output_tokens: Math.ceil(text.length / 4),
      cache_creation_input_tokens: state.calls === 1 ? Math.ceil(body.system[0]!.text.length / 4) : 0,
      cache_read_input_tokens: state.calls === 1 ? 0 : Math.ceil(body.system[0]!.text.length / 4),
    };
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage })) });
  };
  return {
    fetch: fn,
    get calls() {
      return state.calls;
    },
  };
}

function plugins(api: ReturnType<typeof fakeApi>, env: Record<string, string> = { ANTHROPIC_API_KEY: SECRET }): StagePlugin[] {
  const llm = createLabelLlmStage({ provider: "anthropic", make: () => new AnthropicTransport({ env, fetch: api.fetch }) });
  return ALL_STAGES.map((p) => (p.spec.impl === "ts:label.llm@1.0.0" ? llm : p));
}

function guideFile(): string {
  const dir = tmpDir();
  const f = join(dir, "guide.md");
  writeFileSync(f, GUIDE);
  return f;
}

function spec(ext: PipelineSpec["externals"], guide: string, llm: Record<string, unknown> = {}): PipelineSpec {
  const SNAP = { snapshots: { external: "snapshots" }, features: { external: "features" } };
  return {
    format: "gran-prix.pipeline-spec",
    format_version: "1.0.0",
    name: "labels-llm",
    externals: ext as NonNullable<PipelineSpec["externals"]>,
    stages: [
      { id: "heur", kind: "label", impl: "ts:label.heuristic@1.0.0", params: {}, inputs: SNAP },
      {
        id: "llm",
        kind: "label",
        impl: "ts:label.llm@1.0.0",
        params: { model: "model-under-test", prices: PRICES, guide_path: guide, guide_sha256: GUIDE_SHA, routing: { mode: "all" }, ...llm },
        inputs: { ...SNAP, layers: [{ stage: "heur", output: "labels" }] },
      },
    ],
  };
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

const ledgerLines = (dataDir: string): number => (existsSync(dataPaths(dataDir).ledger) ? readFileSync(dataPaths(dataDir).ledger, "utf8").split("\n").filter(Boolean).length : 0);

describe("ts:label.llm@1.0.0", () => {
  it("is registered with typed ports (layers optional) and a pipeline using it checks", () => {
    const reg = new StageRegistry(ALL_STAGES);
    const s = reg.get("ts:label.llm@1.0.0")!.spec;
    expect(s.determinism).toBe("cached-external");
    expect(s.inputs.map((i) => [i.name, i.type, i.optional ?? false, i.many ?? false])).toEqual([
      ["snapshots", "SnapshotSet", false, false],
      ["features", "NodeFeaturesSet", false, false],
      ["layers", "NodeLabelsSet", true, true],
    ]);
    expect(s.outputs.map((o) => o.name)).toEqual(["labels", "report"]);
    const dataDir = tmpDir();
    expect(checkPipeline(spec(externals(dataDir), guideFile()), reg).ok).toBe(true);
    // model and prices are required: no default can pick them silently
    const bad = spec(externals(dataDir), guideFile());
    delete (bad.stages[1]!.params as Record<string, unknown>)["model"];
    expect(checkPipeline(bad, reg).ok).toBe(false);
  });

  it("labels the corpus, writes contract-valid llm labels, a second run is a 100% cache hit, and the key is in no file", async () => {
    const dataDir = tmpDir();
    const ext = externals(dataDir);
    const guide = guideFile();
    const api = fakeApi();
    const first = await runPipeline(spec(ext, guide), { dataDir, plugins: plugins(api), budgetUSD: 5 });
    expect(first.stages.map((s) => s.error).filter(Boolean)).toEqual([]);
    const callsAfterFirst = api.calls;
    expect(callsAfterFirst).toBe(6); // 6 pages, one chunk each
    const llm = first.stages.find((s) => s.stageId === "llm")!;
    expect(llm.costUSD).toBeGreaterThan(0);
    expect(llm.costUSD).toBeLessThan(5);

    const store = new ArtifactStore(dataPaths(dataDir).artifacts);
    const set = store.handle(llm.outputs["labels"] as `sha256:${string}`, "NodeLabelsSet");
    const docs = set.files().map((f) => JSON.parse(Buffer.from(set.file(f)).toString("utf8")) as NodeLabels & Record<string, unknown>);
    expect(docs).toHaveLength(6);
    for (const d of docs) {
      expect(validate("node-labels", d).issues).toEqual([]);
      expect(d.labeler.kind).toBe("llm");
      expect(d.items.length).toBeGreaterThan(0);
      expect(d.items.every((i) => i.source === "llm")).toBe(true);
      expect((d["llm_run"] as { guide_sha256: string }).guide_sha256).toBe(GUIDE_SHA);
      expect(d.labeler.llm?.model).toBe("model-under-test");
    }
    const report = store.handle(llm.outputs["report"] as `sha256:${string}`, "Bundle").json() as LlmReport;
    expect(report.totals).toMatchObject({ pages: 6, calls: 6, cache_hits: 0 });
    const ledgerBefore = ledgerLines(dataDir);

    // forced re-run of the stage: the stage code runs again, every chunk comes from the content-hash cache
    const second = await runPipeline(spec(ext, guide), { dataDir, plugins: plugins(api), budgetUSD: 5, force: true });
    expect(second.stages.find((s) => s.stageId === "llm")!.status).toBe("ran");
    expect(api.calls).toBe(callsAfterFirst);
    expect(ledgerLines(dataDir)).toBe(ledgerBefore); // no reserve, no commit
    expect(second.stages.find((s) => s.stageId === "llm")!.costUSD).toBe(0);
    expect(second.stages.find((s) => s.stageId === "llm")!.outputs["labels"]).toBe(llm.outputs["labels"]);

    // a param that does not change any request (confidence) re-runs the stage and still pays nothing
    const third = await runPipeline(spec(ext, guide, { confidence: 0.9 }), { dataDir, plugins: plugins(api), budgetUSD: 5 });
    const t3 = third.stages.find((s) => s.stageId === "llm")!;
    expect(t3.status).toBe("ran");
    expect(t3.outputs["labels"]).not.toBe(llm.outputs["labels"]);
    expect(api.calls).toBe(callsAfterFirst);
    const r3 = store.handle(t3.outputs["report"] as `sha256:${string}`, "Bundle").json() as LlmReport;
    expect(r3.totals).toMatchObject({ calls: 0, cache_hits: 6, spent_usd: 0 });

    // the key appears in no file the run wrote: artifacts, cache entries, receipts, runs, ledger, llm-cache
    const needle = Buffer.from(SECRET);
    const files = filesUnder(dataDir);
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.includes("llm-cache"))).toBe(true);
    for (const f of files) expect(readFileSync(f).includes(needle), f).toBe(false);
  });

  it("dry_run plans and prints, calls nothing, reserves nothing, and needs no key", async () => {
    const dataDir = tmpDir();
    const ext = externals(dataDir);
    const api = fakeApi();
    const logs: string[] = [];
    const r = await runPipeline(spec(ext, guideFile(), { dry_run: true, include_url_contains: ["article-1.html", "docs-1.html", "forum-1.html"] }), {
      dataDir,
      plugins: plugins(api, {}), // no key at all
      log: (_id, m) => logs.push(m),
    });
    expect(r.ok).toBe(true);
    expect(api.calls).toBe(0);
    expect(existsSync(dataPaths(dataDir).ledger)).toBe(false);
    const llmLogs = logs.filter((l) => /blocks routed|DRY RUN/.test(l));
    expect(llmLogs.length).toBe(4); // 3 pages + the total
    expect(llmLogs.at(-1)).toMatch(/^DRY RUN \(nothing spent\): 3 page\(s\).*estimated \$/);
    console.log(`\n${llmLogs.join("\n")}\n`);
    expect(existsSync(join(dataDir, "llm-cache"))).toBe(false);
  });

  it("without a budget nothing is paid: the stage stops with a clear error, or returns the (empty) finished work with on_budget partial", async () => {
    const dataDir = tmpDir();
    const ext = externals(dataDir);
    const api = fakeApi();
    const r = await runPipeline(spec(ext, guideFile()), { dataDir, plugins: plugins(api) }); // budgetUSD defaults to 0
    const llm = r.stages.find((s) => s.stageId === "llm")!;
    expect(llm.status).toBe("failed");
    expect(llm.error).toContain(new LlmBudgetStopError("x").name);
    expect(llm.error).toMatch(/re-run with a larger --budget-usd/);
    expect(api.calls).toBe(0);
    const p = await runPipeline(spec(ext, guideFile(), { on_budget: "partial" }), { dataDir, plugins: plugins(api) });
    expect(p.stages.find((s) => s.stageId === "llm")!.status).toBe("ran");
    expect(api.calls).toBe(0);
  });

  it("with budget but no ANTHROPIC_API_KEY the stage fails BEFORE touching the ledger", async () => {
    const dataDir = tmpDir();
    const ext = externals(dataDir);
    const api = fakeApi();
    const r = await runPipeline(spec(ext, guideFile()), { dataDir, plugins: plugins(api, {}), budgetUSD: 5 });
    const llm = r.stages.find((s) => s.stageId === "llm")!;
    expect(llm.status).toBe("failed");
    expect(llm.error).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(api.calls).toBe(0);
    expect(existsSync(dataPaths(dataDir).ledger)).toBe(false);
  });

  it("current models: a combination the API rejects fails the stage before any call or ledger line (dry run included)", async () => {
    const dataDir = tmpDir();
    const ext = externals(dataDir);
    const api = fakeApi();
    for (const llm of [
      { model: "claude-opus-5-5" }, // send_temperature defaults to true: Opus rejects the parameter
      { model: "claude-sonnet-5-5", dry_run: true },
      { model: "claude-haiku-5-5" },
      { model: "claude-opus-5-5", send_temperature: false, thinking: "off" },
      { model: "some-future-model", send_temperature: false, effort: "low" },
    ]) {
      const r = await runPipeline(spec(ext, guideFile(), llm), { dataDir, plugins: plugins(api), budgetUSD: 5 });
      const s = r.stages.find((x) => x.stageId === "llm")!;
      expect(s.status, JSON.stringify(llm)).toBe("failed");
      expect(s.error).toMatch(/send_temperature to false|always thinks|not in the validated table/);
    }
    expect(api.calls).toBe(0);
    expect(existsSync(dataPaths(dataDir).ledger)).toBe(false);
  });

  it("current models: thinking off + effort + no temperature go in the body, the thinking headroom in max_tokens, and into the labels", async () => {
    const dataDir = tmpDir();
    const ext = externals(dataDir);
    const bodies: Array<Record<string, unknown>> = [];
    const base = fakeApi();
    const api = {
      fetch: ((url, init) => {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        return base.fetch(url, init);
      }) as typeof base.fetch,
      get calls() {
        return base.calls;
      },
    };
    const prices = { input_usd_per_mtok: 2, output_usd_per_mtok: 10, cache_write_usd_per_mtok: 2.5, cache_read_usd_per_mtok: 0.1 };
    const sonnet = { model: "claude-sonnet-5-5", prices, send_temperature: false, include_url_contains: ["article-1.html"] };

    const off = await runPipeline(spec(ext, guideFile(), { ...sonnet, thinking: "off", effort: "low" }), { dataDir, plugins: plugins(api), budgetUSD: 5 });
    expect(off.stages.map((s) => s.error).filter(Boolean)).toEqual([]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: "claude-sonnet-5-5", thinking: { type: "between_tools" } });
    expect((bodies[0]!["output_config"] as { effort: string }).effort).toBe("low");
    expect(bodies[0]).not.toHaveProperty("temperature");
    const maxOff = bodies[0]!["max_tokens"] as number;

    // default thinking: no `thinking` field, 8000 more tokens of room (billed as output, reserved at the output price)
    const on = await runPipeline(spec(ext, guideFile(), sonnet), { dataDir, plugins: plugins(api), budgetUSD: 5 });
    expect(on.stages.map((s) => s.error).filter(Boolean)).toEqual([]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("thinking");
    expect((bodies[1]!["output_config"] as Record<string, unknown>)["effort"]).toBeUndefined();
    expect(bodies[1]!["max_tokens"]).toBe(maxOff + 8000);

    const store = new ArtifactStore(dataPaths(dataDir).artifacts);
    const labels = (r: typeof off): Array<Record<string, unknown>> => {
      const set = store.handle(r.stages.find((s) => s.stageId === "llm")!.outputs["labels"] as `sha256:${string}`, "NodeLabelsSet");
      return set.files().map((f) => JSON.parse(Buffer.from(set.file(f)).toString("utf8")) as Record<string, unknown>);
    };
    expect(labels(off)[0]!["llm_run"]).toMatchObject({ thinking: "off", effort: "low", temperature_sent: false });
    expect(labels(on)[0]!["llm_run"]).toMatchObject({ thinking: "model-default", effort: null, temperature_sent: false });
  });

  it("split_filter keeps only the pages of the given splits (hash-bucket-v1 over group_key), so one pipeline can route dev and test differently", async () => {
    const dataDir = tmpDir();
    const ext = externals(dataDir);
    const entries = (JSON.parse(readFileSync(join(corpus, "features-set", "manifest.json"), "utf8")) as { entries: Array<{ group_key: string }> }).entries;
    const ranges = { train: [0, 50], val: [50, 50], test: [50, 100] } as const;
    // a salt that cuts the 6 pages in two non-empty halves
    const half = (salt: string, name: "train" | "test"): number => entries.filter((e) => assignSplit(salt, e.group_key, { ranges: ranges as never }).split === name).length;
    const salt = Array.from({ length: 200 }, (_, i) => `gp-test-s${i}`).find((s) => half(s, "train") > 0 && half(s, "test") > 0)!;
    expect(salt).toBeDefined();
    const count = async (include: string[]): Promise<number> => {
      const r = await runPipeline(spec(ext, guideFile(), { dry_run: true, split_filter: { salt, ranges, include } }), { dataDir, plugins: plugins(fakeApi(), {}) });
      expect(r.ok).toBe(true);
      const llm = r.stages.find((s) => s.stageId === "llm")!;
      const store = new ArtifactStore(dataPaths(dataDir).artifacts);
      return (store.handle(llm.outputs["report"] as `sha256:${string}`, "Bundle").json() as LlmReport).totals.pages;
    };
    const train = await count(["train"]);
    const test = await count(["test"]);
    expect(train).toBe(half(salt, "train"));
    expect(test).toBe(half(salt, "test"));
    expect(train + test).toBe(entries.length);
    expect(await count(["train", "val", "test"])).toBe(entries.length);
  });

  it("refuses a guide that is not the pinned one", async () => {
    const dataDir = tmpDir();
    const bad = spec(externals(dataDir), guideFile(), { guide_sha256: "0".repeat(64) });
    const r = await runPipeline(bad, { dataDir, plugins: plugins(fakeApi()), budgetUSD: 5 });
    expect(r.stages.find((s) => s.stageId === "llm")!.error).toMatch(/frozen guide changed/);
  });
});
