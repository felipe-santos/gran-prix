// E3.5 (L6t): `ts:measure.tokens@1.0.0` in a mini pipeline over the 13 synthetic fixture pages:
// collect (Chromium) -> extract -> label.truth (the oracle system) -> measure.tokens.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contractId, validate, type PipelineSpec, type Sha256 } from "@gran-prix/contracts";
import { groupIdOf } from "@gran-prix/labels";
import { countTokens } from "@gran-prix/markdown";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore, StageRegistry, checkPipeline, dataPaths, runPipeline, type RunSummary } from "../src/index.js";
import { SnapshotSetReader } from "../src/stages/collect-stages.js";
import { ALL_STAGES } from "../src/stages/index.js";
import { measureTokens } from "../src/stages/tokens/index.js";
import type { PageTokens, SystemReport } from "../src/stages/tokens/report.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const GOLDEN = fileURLToPath(new URL("./golden/tokens/", import.meta.url));
const FIXTURES = join(ROOT, "fixtures/pages");
const NAMES = ["article-1", "article-2", "docs-1", "docs-2", "docs-3", "forum-1", "forum-2", "landing-1", "landing-2", "product-1", "product-2", "spa-1", "spa-2"];
const GOLDEN_PAGES = ["article-1", "product-1", "docs-3"];
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

interface TokensDoc {
  format: string;
  tokenizer: string;
  converter: string;
  policy: { collapsed: string };
  pages: PageTokens[];
  systems: SystemReport[];
}

function spec(urlsPath: string, params: Record<string, unknown> = { names: ["oracle"] }): PipelineSpec {
  return {
    format: "gran-prix.pipeline-spec",
    format_version: "1.0.0",
    name: "mini-measure-tokens",
    externals: {
      urls: { type: "UrlList", path: urlsPath },
      schema: { type: "FeatureSchema", path: "packages/features/src/schema/feature-schema.v0.json" },
    },
    stages: [
      { id: "collect", kind: "collect", impl: "ts:collect.playwright@1.0.0", params: { viewport: [1280, 900], captured_at: "2026-01-01T00:00:00Z", fail_on_error: true }, inputs: { urls: { external: "urls" } } },
      { id: "extract", kind: "extract", impl: "ts:extract.dom-node@1.0.0", params: {}, inputs: { snapshots: { stage: "collect", output: "snapshots" }, schema: { external: "schema" } } },
      {
        id: "truth",
        kind: "label",
        impl: "ts:label.truth@1.0.0",
        params: { pages: NAMES.map((n) => ({ url_contains: `/${n}.html`, rules: readJson<{ rules: unknown[] }>(join(FIXTURES, `${n}.truth.json`)).rules })) },
        inputs: { snapshots: { stage: "collect", output: "snapshots" }, features: { stage: "extract", output: "features" } },
      },
      {
        id: "tokens",
        kind: "evaluate",
        impl: "ts:measure.tokens@1.0.0",
        params,
        inputs: { snapshots: { stage: "collect", output: "snapshots" }, systems: [{ stage: "truth", output: "labels" }] },
      },
    ],
  } as PipelineSpec;
}

const out = (r: RunSummary, stage: string, port: string): Sha256 => {
  const id = r.stages.find((s) => s.stageId === stage)?.outputs[port];
  if (typeof id !== "string") throw new Error(`no output ${stage}.${port}`);
  return id as Sha256;
};

let dataDir: string;
let store: ArtifactStore;
let run: RunSummary;
let doc: TokensDoc;
let md: { file(p: string): Uint8Array; files(): string[] };
let snaps: SnapshotSetReader;
const text = (b: Uint8Array): string => Buffer.from(b).toString("utf8");

beforeAll(async () => {
  const dir = tmpDir("gp-tokens-");
  const urls = join(dir, "urls.json");
  writeFileSync(urls, JSON.stringify(NAMES.map((n) => ({ url: `fixtures/pages/${n}.html`, stratum: readJson<{ category: string }>(join(FIXTURES, `${n}.truth.json`)).category }))));
  dataDir = join(dir, "data");
  run = await runPipeline(spec(urls), { dataDir, root: ROOT, log: () => undefined });
  store = new ArtifactStore(dataPaths(dataDir).artifacts);
  doc = store.handle(out(run, "tokens", "tokens"), "Bundle").json() as TokensDoc;
  md = store.handle(out(run, "tokens", "markdown"), "Bundle");
  snaps = new SnapshotSetReader(store.handle(out(run, "collect", "snapshots"), "SnapshotSet"));
  const dump = process.env["TOKENS_DUMP"]; // review aid: TOKENS_DUMP=<dir> writes every markdown file (named by page) there
  if (dump) {
    for (const f of md.files()) {
      const hex = f.match(/([0-9a-f]{12})\.md$/)?.[1];
      const name = snaps.entries().find((e) => e.snapshot_id.includes(hex ?? "-"))?.url.split("/").pop()?.replace(".html", "");
      const target = join(dump, name === undefined ? f : f.replace(`${hex}.md`, `${name}.md`));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(md.file(f)));
    }
  }
});

const page = (name: string): PageTokens => doc.pages.find((p) => p.url_key.endsWith(`/${name}.html`)) as PageTokens;
const d2Of = (name: string): string => {
  const p = page(name);
  return text(md.file(`d2/${p.snapshot_id.slice("sha256:".length, "sha256:".length + 12)}.md`));
};

describe("ts:measure.tokens@1.0.0 in a mini pipeline", () => {
  it("is registered and the pipeline passes the registry check", () => {
    const r = checkPipeline(spec("x"), new StageRegistry(ALL_STAGES));
    expect(r.ok ? [] : r.issues).toEqual([]);
    const plugin = ALL_STAGES.find((s) => s.spec.impl === "ts:measure.tokens@1.0.0");
    expect(plugin?.spec.determinism).toBe("pure");
    // the cache key carries the converter, turndown, the plugin, the tokenizer and jsdom
    expect(Object.keys(plugin?.toolDigests?.() ?? {}).sort()).toEqual(["gp-markdown", "js-tiktoken", "jsdom", "turndown", "turndown-plugin-gfm"]);
  });

  it("runs all four stages and counts the 13 pages", () => {
    expect(run.ok, JSON.stringify(run.stages.map((s) => [s.stageId, s.status, s.error]))).toBe(true);
    expect(doc.format).toBe("gran-prix.token-measure");
    expect(doc.pages).toHaveLength(13);
    expect(doc.policy.collapsed).toBe("exclude");
    expect(doc.tokenizer).toMatch(/^cl100k_base@js-tiktoken@\d/);
    expect(doc.converter).toMatch(/^gp-markdown@.*\+turndown@\d.*\+gfm@\d/);
    expect(doc.systems.map((s) => s.id)).toEqual(["oracle"]);
  });

  it("per page: D1 and D2 are non-empty, the oracle output is a subset of D2, and ids join with the dataset's group_id", () => {
    const entries = snaps.entries();
    for (const p of doc.pages) {
      expect(p.tokens_d1, p.url_key).toBeGreaterThan(0);
      expect(p.tokens_d2, p.url_key).toBeGreaterThan(0);
      expect(p.tokens_d2_collapsed, p.url_key).toBeGreaterThanOrEqual(p.tokens_d2);
      expect(p.tokens_d1, p.url_key).toBeGreaterThan(p.tokens_d2); // markup costs more than the text it carries
      const o = p.tokens_out["oracle"] as number;
      expect(o, p.url_key).toBeGreaterThan(0);
      expect(o, p.url_key).toBeLessThanOrEqual(p.tokens_d2);
      const e = entries.find((x) => x.snapshot_id === p.snapshot_id) as (typeof entries)[number];
      expect(p.group_id).toBe(groupIdOf({ group_key: e.group_key, snapshot_id: e.snapshot_id } as Parameters<typeof groupIdOf>[0]));
      expect(p.stratum).toBe(e.stratum);
      expect(p.notes.unstamped_elements, p.url_key).toBe(0);
    }
  });

  it("the stored token counts are the cl100k count of the stored markdown files", () => {
    for (const p of doc.pages) {
      const h = p.snapshot_id.slice("sha256:".length, "sha256:".length + 12);
      expect(countTokens(text(md.file(`d2/${h}.md`))), p.url_key).toBe(p.tokens_d2);
      expect(countTokens(text(md.file(`out/oracle/${h}.md`))), p.url_key).toBe(p.tokens_out["oracle"]);
    }
  });

  it("D2 has no markup left, no scripts or styles, no image URLs and no data URIs", () => {
    for (const p of doc.pages) {
      const h = p.snapshot_id.slice("sha256:".length, "sha256:".length + 12);
      const d2 = text(md.file(`d2/${h}.md`));
      expect(d2, p.url_key).not.toMatch(/data-gp-|<script|<style|<svg|data:image|!\[[^\]]*\]\([^)]+\)/);
    }
  });

  it("the D2 markdown of three fixtures equals its golden file (UPDATE_GOLDEN=1 rewrites them)", () => {
    for (const name of GOLDEN_PAGES) {
      const file = join(GOLDEN, `${name}.d2.md`);
      const actual = d2Of(name);
      if (process.env["UPDATE_GOLDEN"] === "1") {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, actual);
      }
      expect(existsSync(file), `${file} missing: run once with UPDATE_GOLDEN=1 and review it`).toBe(true);
      expect(actual, name).toBe(readFileSync(file, "utf8"));
    }
  });

  it("unrendered content of article-1 is not in D2 (the closed subscribe modal, the sr-only link), rendered noise is (the cookie banner)", () => {
    const article = d2Of("article-1");
    expect(article).not.toContain("Keep reading for free"); // #subscribe-modal.hidden: display:none
    expect(article).not.toContain("Skip to comments"); // a.sr-only: left:-9999px, 1x1
    expect(article).toMatch(/cookies/i); // rendered, so it is page text (the labels call it noise; D2 is the WHOLE rendered page)
    expect(article).toContain("Most read");
  });

  it("two executions of the stage produce byte-identical artifacts, equal to the pipeline's", async () => {
    const ctx = (): Parameters<typeof measureTokens.run>[0] =>
      ({
        params: { names: ["oracle"] },
        inputs: {
          snapshots: store.handle(out(run, "collect", "snapshots"), "SnapshotSet"),
          systems: [store.handle(out(run, "truth", "labels"), "NodeLabelsSet")],
        },
        log: () => undefined,
      }) as unknown as Parameters<typeof measureTokens.run>[0];
    const a = (await measureTokens.run(ctx())) as Record<string, { json?: unknown; files?: Record<string, string> }>;
    const b = (await measureTokens.run(ctx())) as typeof a;
    expect(JSON.stringify(a["tokens"]?.json)).toBe(JSON.stringify(b["tokens"]?.json));
    expect(a["markdown"]?.files).toEqual(b["markdown"]?.files);
    expect(a["tokens"]?.json).toEqual(doc);
    for (const [path, content] of Object.entries(a["markdown"]?.files ?? {})) expect(text(md.file(path)), path).toBe(content);
  });

  // A prediction bundle as `{ id, threshold, predictions: [{ g, u, p }] }` served as a JSON artifact handle.
  const jsonHandle = (doc: unknown) => ({ id: "sha256:" + "0".repeat(64), type: "Bundle", dir: "", json: () => doc, file: () => new Uint8Array(), files: () => [] as string[] });
  const runWith = async (predictions: unknown[], params: Record<string, unknown> = {}) => {
    const r = (await measureTokens.run({
      params,
      inputs: { snapshots: store.handle(out(run, "collect", "snapshots"), "SnapshotSet"), predictions: predictions.map(jsonHandle) },
      log: () => undefined,
    } as unknown as Parameters<typeof measureTokens.run>[0])) as Record<string, { json?: unknown; files?: Record<string, string> }>;
    return { doc: r["tokens"]?.json as TokensDoc, files: r["markdown"]?.files ?? {} };
  };
  const everyUnit = (name: string, p: number) => {
    const entry = snaps.entries().find((e) => e.url.endsWith(`/${name}.html`)) as ReturnType<SnapshotSetReader["entries"]>[number];
    const g = `${entry.group_key}#${entry.snapshot_id.slice("sha256:".length, "sha256:".length + 12)}`;
    return snaps.snapshot(entry).nodes.filter((n) => n.own_text_len > 0).map((n) => ({ g, u: n.idx, p }));
  };

  it("a prediction bundle works as a system; keeping every unit gives D2 up to the images that no unit owns; a page it does not cover is an empty output with no credit", async () => {
    const all = NAMES.slice(0, 5).flatMap((n) => everyUnit(n, 1)); // five pages covered, eight not
    const { doc: d, files } = await runWith([{ id: "keep-all", threshold: 0.5, predictions: all }]);
    const sys = d.systems[0] as SystemReport;
    expect(sys.id).toBe("keep-all");
    expect(sys.pages_covered).toBe(5);
    const strip = (s: string): string => s.replace(/!\[[^\]]*\]\(\)/g, "").replace(/\s+/g, " ").trim();
    for (const p of d.pages) {
      const h = p.snapshot_id.slice("sha256:".length, "sha256:".length + 12);
      if (p.n_keep["keep-all"] === null) {
        expect(p.tokens_out["keep-all"], p.url_key).toBe(0);
        continue;
      }
      expect(p.tokens_out["keep-all"], p.url_key).toBeLessThanOrEqual(p.tokens_d2);
      const a = strip(files[`out/keep-all/${h}.md`] as string);
      const b = strip(files[`d2/${h}.md`] as string);
      let at = 0;
      while (at < a.length && a[at] === b[at]) at++;
      expect(a === b, `${p.url_key} differs at ${at}: keep-all ...${a.slice(Math.max(0, at - 40), at + 80)} | D2 ...${b.slice(Math.max(0, at - 40), at + 80)}`).toBe(true);
    }
    // 8 of 13 pages empty: no credit, so the median reduction is 0 and the empties are counted
    expect(sys.stats.d2.n_empty).toBe(8);
    expect(sys.stats.d2.median_reduction).toBe(0);
    expect(sys.stats.d2.n_pages).toBe(13);
  });

  it("scores under the threshold are not kept; a system with nothing kept is empty everywhere and earns nothing", async () => {
    const none = NAMES.flatMap((n) => everyUnit(n, 0.2));
    const { doc: d } = await runWith([{ id: "none", threshold: 0.5, predictions: none }]);
    const sys = d.systems[0] as SystemReport;
    expect(sys.stats.d2.n_empty).toBe(13);
    expect(sys.token_reduction.d2.median_reduction).toBe(0);
    expect(sys.token_reduction.d2.pooled_ratio).toBe(1);
    expect(d.pages.every((p) => p.tokens_out["none"] === 0)).toBe(true);
  });

  it("collapsed: include enlarges D2 where a page has collapsed content (docs-3), and only there", async () => {
    const d = (await runWith([], {})).doc;
    for (const p of d.pages) {
      if (p.url_key.endsWith("/docs-3.html")) {
        expect(p.notes.disclosure_nodes).toBeGreaterThan(0);
        expect(p.tokens_d2_collapsed).toBeGreaterThan(p.tokens_d2);
      } else if (p.notes.disclosure_nodes === 0) {
        expect(p.tokens_d2_collapsed, p.url_key).toBe(p.tokens_d2);
      }
    }
    const inc = (await runWith([], { collapsed: "include" })).doc;
    expect(inc.policy.collapsed).toBe("include");
    expect((inc.pages.find((p) => p.url_key.endsWith("/docs-3.html")) as PageTokens).tokens_d2).toBe((d.pages.find((p) => p.url_key.endsWith("/docs-3.html")) as PageTokens).tokens_d2_collapsed);
  });

  it("refuses ambiguous or unusable system names and malformed predictions", async () => {
    const a = { id: "x", predictions: [] };
    await expect(runWith([a, { ...a }])).rejects.toThrow(/two systems claim the id "x"/);
    await expect(runWith([{ id: "bad/id", predictions: [] }])).rejects.toThrow(/not usable as a file name/);
    await expect(runWith([{ id: "ok", predictions: [{ g: "nohash", u: 1, p: 1 }] }])).rejects.toThrow(/snapshot hex12/);
    await expect(runWith([{ id: "ok", predictions: [{ g: "a#b", u: 1, p: 2 }] }])).rejects.toThrow(/p must be/);
  });

  it("a second pipeline run is a cache hit", async () => {
    const dir = dirname(dataDir);
    const again = await runPipeline(spec(join(dir, "urls.json")), { dataDir, root: ROOT, log: () => undefined });
    expect(again.counts).toMatchObject({ ran: 0, failed: 0 });
    expect(out(again, "tokens", "tokens")).toBe(out(run, "tokens", "tokens"));
  });

  it("the system's token_reduction block is a valid EvalReport v1.1 block (spliced into the contract's example report)", () => {
    const sys = doc.systems[0] as SystemReport;
    const report = readJson<{ report_id: string; intrinsic: Record<string, unknown> }>(join(ROOT, "packages/contracts/fixtures/valid/eval-report.json"));
    report.intrinsic["token_reduction"] = sys.token_reduction;
    report.report_id = contractId("eval-report", report as never); // the id hashes the content
    const r = validate("eval-report", report);
    expect(r.issues).toEqual([]);
    expect(sys.token_reduction.d2.n_pages).toBe(13);
  });

  it("per-page counts fit per_group[] (tokens_d1, tokens_d2, tokens_kept = the system's output)", () => {
    for (const p of doc.pages) {
      const group = { group_id: p.group_id, stratum: p.stratum, tokens_d1: p.tokens_d1, tokens_d2: p.tokens_d2, tokens_kept: p.tokens_out["oracle"] };
      expect(Number.isInteger(group.tokens_d1) && Number.isInteger(group.tokens_d2) && Number.isInteger(group.tokens_kept)).toBe(true);
    }
  });

  it("'rendered' is the rule of U: for every unit of every fixture, the converter keeps its text iff the Studio's computeUniverse says U", async () => {
    // The Studio's universe.ts is loaded by path (tools/studio depends on this package, not the reverse). Until the Studio
    // imports isRenderedNode from @gran-prix/markdown, this test is what keeps the two copies of the rule identical.
    const universePath = join(ROOT, "tools/studio/src/core/universe.ts");
    const { computeUniverse } = (await import(/* @vite-ignore */ universePath)) as { computeUniverse(nodes: unknown): Uint8Array };
    const { planPage } = await import("@gran-prix/markdown");
    let units = 0;
    let disclosure = 0;
    for (const entry of snaps.entries()) {
      const nodes = snaps.snapshot(entry).nodes;
      const u = computeUniverse(nodes);
      const inclusive = planPage(nodes, { collapsed: "include" }).text;
      const exclusive = planPage(nodes, { collapsed: "exclude" }).text;
      const inSvg = new Uint8Array(nodes.length);
      nodes.forEach((n, i) => (inSvg[i] = n.tag === "svg" || (n.parent >= 0 && inSvg[n.parent] === 1) ? 1 : 0)); // D2 drops svg wholesale; U does not look at it
      nodes.forEach((n, i) => {
        if (n.own_text_len === 0 || inSvg[i] === 1) return;
        const where = `${entry.url} n${i} <${n.tag}>`;
        units++;
        // include: text survives for every unit of U (rendered or disclosure); exclude: only for the rendered ones
        expect(inclusive[i] === 1, where).toBe(u[i] !== 0);
        expect(exclusive[i] === 1, where).toBe(u[i] === 1);
        if (u[i] === 2) disclosure++;
      });
    }
    expect(units).toBeGreaterThan(300);
    expect(disclosure).toBeGreaterThan(0); // docs-3 has collapsed content: the disclosure branch is exercised
  });

  it("the oracle reduction by D2 and D1, per fixture and overall (descriptive; printed for the lane report)", () => {
    const rows = doc.pages.map((p) => {
      const o = p.tokens_out["oracle"] as number;
      return `${p.url_key.split("/").pop()?.replace(".html", "").padEnd(10)} ${p.stratum.padEnd(8)} D1=${String(p.tokens_d1).padStart(6)} D2=${String(p.tokens_d2).padStart(6)} out=${String(o).padStart(6)} D2/out=${(p.tokens_d2 / o).toFixed(2).padStart(6)} D1/out=${(p.tokens_d1 / o).toFixed(2).padStart(7)}`;
    });
    const s = (doc.systems[0] as SystemReport).stats;
    console.log(`\n${rows.join("\n")}\nmedian D2/out=${s.d2.median_reduction?.toFixed(3)} IQR=${s.d2.iqr_reduction?.map((x) => x.toFixed(2)).join("..")}  median D1/out=${s.d1.median_reduction?.toFixed(3)} IQR=${s.d1.iqr_reduction?.map((x) => x.toFixed(2)).join("..")}  pooled D2=${s.d2.pooled_reduction?.toFixed(3)} D1=${s.d1.pooled_reduction?.toFixed(3)}`);
    expect(rows).toHaveLength(13);
  });
});
