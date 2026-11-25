// E1.5 acceptance: the mini pipeline (3 fixture pages) through the real collect + extract stages.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Of, validate, type NodeFeatures, type PageSnapshot, type PipelineSpec, type Sha256 } from "@gran-prix/contracts";
import { vectorize } from "@gran-prix/features";
import { JSDOM } from "jsdom";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore, dataPaths, runPipeline, type RunSummary } from "../src/index.js";
import { NodeFeaturesSetReader, SnapshotSetReader } from "../src/stages/collect-stages.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PIPELINE = JSON.parse(readFileSync(join(ROOT, "tools/cli/test/pipelines/mini-collect-extract.pipeline.json"), "utf8")) as PipelineSpec;

/** The pipeline file resolves paths against the repo root through `ctx.root` (`opts.root`): vitest runs from tools/cli and no `base_dir` is pinned. */
function spec(over: { captured_at?: string | null } = {}): PipelineSpec {
  const s = structuredClone(PIPELINE);
  const params = (s.stages[0] as { params: Record<string, unknown> }).params;
  if (over.captured_at === null) delete params["captured_at"];
  else if (over.captured_at !== undefined) params["captured_at"] = over.captured_at;
  return s;
}

const logs: string[] = [];
const opts = (dataDir: string) => ({ dataDir, root: ROOT, log: (stage: string, m: string) => logs.push(`${stage}: ${m}`) });
const out = (r: RunSummary, stage: string, port: string): Sha256 => {
  const id = r.stages.find((s) => s.stageId === stage)?.outputs[port];
  if (typeof id !== "string") throw new Error(`no output ${stage}.${port}`);
  return id as Sha256;
};

let dataDir: string;
let first: RunSummary;
let store: ArtifactStore;

beforeAll(async () => {
  dataDir = tmpDir("gp-collect-");
  first = await runPipeline(spec(), opts(dataDir));
  store = new ArtifactStore(dataPaths(dataDir).artifacts);
});

describe("mini pipeline: 3 fixture pages -> snapshots -> features", () => {
  it("runs both stages", () => {
    expect(first.ok, JSON.stringify(first.stages.map((s) => [s.stageId, s.status, s.error]))).toBe(true);
    expect(first.counts).toMatchObject({ ran: 2, cached: 0, failed: 0 });
    expect(logs.some((l) => l.startsWith("collect: fixtures/pages/spa-1.html"))).toBe(true);
  });

  it("the SnapshotSet holds one contract-valid, id-verified PageSnapshot per page, in UrlList order", () => {
    const set = new SnapshotSetReader(store.handle(out(first, "collect", "snapshots"), "SnapshotSet"));
    const m = set.manifest();
    expect(m.failures).toEqual([]);
    expect(m.entries.map((e) => [e.url, e.stratum, e.group_key])).toEqual([
      ["file:///fixtures/pages/article-1.html", "article", "article-1"],
      ["file:///fixtures/pages/product-2.html", "product", "product-2"],
      ["file:///fixtures/pages/spa-1.html", "spa", "spa-1"],
    ]);
    for (const e of m.entries) {
      const snap = set.snapshot(e);
      const r = validate("page-snapshot", snap); // includes the snapshot_id recomputation
      expect(r.issues, e.url).toEqual([]);
      expect(snap.snapshot_id).toBe(e.snapshot_id);
      expect(snap.page.url).toBe(e.url);
      expect(snap.page.category).toBe(e.stratum);
      expect(snap.nodes.length).toBe(e.node_count);
      expect(snap.capture.captured_at).toBe("2026-01-01T00:00:00Z");
      expect(e.flags).toEqual([]);
      expect(e.http_status).toBe(200);
    }
    // The SPA page was captured after its render waves (DOM-quiet), not right after load.
    const spa = m.entries.find((e) => e.stratum === "spa");
    expect(spa?.node_count).toBeGreaterThan(30);
  });

  it("every NodeFeatures validates and equals a direct vectorize of the stored snapshot", () => {
    const snaps = new SnapshotSetReader(store.handle(out(first, "collect", "snapshots"), "SnapshotSet"));
    const feats = new NodeFeaturesSetReader(store.handle(out(first, "extract", "features"), "NodeFeaturesSet"));
    const schema = JSON.parse(readFileSync(join(ROOT, "packages/features/src/schema/feature-schema.v0.json"), "utf8")) as Parameters<typeof vectorize>[1];
    const fm = feats.manifest();
    expect(fm.entries.map((e) => e.snapshot_id)).toEqual(snaps.entries().map((e) => e.snapshot_id));
    expect(fm.feature_schema_id).toBe((schema as { schema_id?: string }).schema_id);
    for (const e of fm.entries) {
      const nf = feats.features(e);
      expect(validate("node-features", nf).issues, e.snapshot_id).toEqual([]);
      expect(nf.features_id).toBe(e.features_id);
      const snapEntry = snaps.entries().find((s) => s.snapshot_id === e.snapshot_id);
      expect(snapEntry).toBeDefined();
      expect(e.group_key).toBe(snapEntry?.group_key);
      const direct = vectorize(snaps.snapshot(snapEntry as { snapshot: string }) as PageSnapshot, schema) as unknown as NodeFeatures;
      expect(nf).toEqual(JSON.parse(JSON.stringify(direct)));
      expect(e.n_rows).toBeGreaterThan(5);
    }
  });

  it("the second run is a 100% cache hit with identical artifact ids", async () => {
    const second = await runPipeline(spec(), opts(dataDir));
    expect(second.ok).toBe(true);
    expect(second.counts).toMatchObject({ ran: 0, cached: 2, failed: 0 });
    expect(second.stages.map((s) => s.outputs)).toEqual(first.stages.map((s) => s.outputs));
    for (const s of second.stages) for (const id of Object.values(s.outputs).flat()) expect(store.verify(id as Sha256)).toBe(true);
  });

  it("a forced re-collect gives identical snapshot ids (and, with captured_at pinned, identical set ids)", async () => {
    const dir2 = tmpDir("gp-collect-force-");
    const forced = await runPipeline(spec(), { ...opts(dir2), force: true });
    expect(forced.counts).toMatchObject({ ran: 2 });
    const a = new SnapshotSetReader(store.handle(out(first, "collect", "snapshots"), "SnapshotSet")).entries().map((e) => e.snapshot_id);
    const b = new SnapshotSetReader(new ArtifactStore(dataPaths(dir2).artifacts).handle(out(forced, "collect", "snapshots"), "SnapshotSet")).entries().map((e) => e.snapshot_id);
    expect(b).toEqual(a);
    expect(out(forced, "collect", "snapshots")).toBe(out(first, "collect", "snapshots"));
    expect(out(forced, "extract", "features")).toBe(out(first, "extract", "features"));
  });

  it("with the clock instead of a pinned captured_at, snapshot_id and features_id still do not move", async () => {
    const d1 = tmpDir("gp-collect-clock-a-");
    const d2 = tmpDir("gp-collect-clock-b-");
    const r1 = await runPipeline(spec({ captured_at: null }), opts(d1));
    await new Promise((r) => setTimeout(r, 1100)); // the ISO timestamps differ by >= 1 s
    const r2 = await runPipeline(spec({ captured_at: null }), opts(d2));
    const ids = (r: RunSummary, dir: string) => {
      const st = new ArtifactStore(dataPaths(dir).artifacts);
      const set = new SnapshotSetReader(st.handle(out(r, "collect", "snapshots"), "SnapshotSet"));
      const entries = set.entries();
      return {
        snaps: entries.map((e) => e.snapshot_id),
        feats: new NodeFeaturesSetReader(st.handle(out(r, "extract", "features"), "NodeFeaturesSet")).entries().map((e) => e.features_id),
        capturedAt: set.snapshot(entries[0] as { snapshot: string }).capture.captured_at,
      };
    };
    const a = ids(r1, d1);
    const b = ids(r2, d2);
    expect(b.snaps).toEqual(a.snaps);
    expect(b.feats).toEqual(a.feats);
    expect(b.capturedAt).not.toBe(a.capturedAt); // the volatile field really is volatile, and stays out of the id
  });
});

describe("flattened HTML (the contract with the label stage)", () => {
  it("is gzip whose decoded sha256/bytes match the FileRef, with no <script>", () => {
    const set = new SnapshotSetReader(store.handle(out(first, "collect", "snapshots"), "SnapshotSet"));
    for (const e of set.entries()) {
      const ref = set.snapshot(e).html as { path: string; sha256: string; bytes: number; media_type?: string; content_encoding?: string };
      expect(ref.path).toBe(e.html);
      expect(ref.content_encoding).toBe("gzip");
      expect(ref.media_type).toBe("text/html");
      const decoded = new TextDecoder().decode(gunzipSync(store.handle(out(first, "collect", "snapshots"), "SnapshotSet").file(ref.path)));
      expect(sha256Of(decoded)).toBe(ref.sha256);
      expect(Buffer.byteLength(decoded)).toBe(ref.bytes);
      // scripts keep their element (and id) but carry no code
      const doc = new JSDOM(decoded).window.document;
      for (const s of Array.from(doc.querySelectorAll("script"))) {
        expect(s.textContent).toBe("");
        expect(s.getAttributeNames().filter((a) => a !== "data-gp-id")).toEqual([]);
      }
    }
  });

  it("round-trips through jsdom: every snapshot element id is present, on the right tag, exactly once", () => {
    const set = new SnapshotSetReader(store.handle(out(first, "collect", "snapshots"), "SnapshotSet"));
    let shadowNodes = 0;
    for (const e of set.entries()) {
      const snap = set.snapshot(e);
      const doc = new JSDOM(set.html(e)).window.document;
      const byId = new Map<string, Element>();
      for (const el of Array.from(doc.querySelectorAll("[data-gp-id]"))) {
        const id = el.getAttribute("data-gp-id") as string;
        expect(byId.has(id), `${e.url}: duplicate ${id}`).toBe(false);
        byId.set(id, el);
      }
      for (const n of snap.nodes) {
        const el = byId.get(`n${n.idx}`);
        expect(el, `${e.url}: n${n.idx} <${n.tag}> missing`).toBeDefined();
        expect(el?.localName).toBe(n.tag);
        if (n.flags.in_shadow) shadowNodes++;
      }
      expect(byId.size).toBeGreaterThanOrEqual(snap.nodes.length);
    }
    expect(shadowNodes, "the fixtures must exercise inlined open shadow roots").toBeGreaterThan(0);
  });
});
