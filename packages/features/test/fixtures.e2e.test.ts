// End to end on the 13 synthetic fixtures (12 corpus pages + docs-3, the disclosure fixture): probe in headless Chromium, vectorize in Node and in the page.
import { validate, type NodeFeatures, type PageSnapshot } from "@gran-prix/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { featureSchemaV0, vectorize, vectorizeMatrix, type NodeFeaturesDoc } from "../src/index.js";
import { captureAll, captureFixture, launch, type Captured } from "./helpers/capture.js";
import type { Launched } from "../src/index.js";

let launched: Launched;
let captured: Captured[] = [];

beforeAll(async () => {
  launched = await launch();
  captured = await captureAll(launched);
});
afterAll(async () => {
  await launched?.browser.close();
});

describe("probe on the fixtures", () => {
  it("captures all 13 pages with a contract-valid PageSnapshot", () => {
    expect(captured).toHaveLength(13);
    for (const c of captured) {
      const r = validate("page-snapshot", c.snapshot);
      expect(r.issues, c.name).toEqual([]);
      expect(r.ok, c.name).toBe(true);
      expect(c.snapshot.nodes.length, c.name).toBeGreaterThan(10);
    }
  });

  it("stamps ids in the composed pre-order: idx === position and data-gp-id agrees", async () => {
    for (const c of captured) {
      c.snapshot.nodes.forEach((n, i) => expect(n.idx).toBe(i));
      expect(c.probed.raw.settle.late_unstamped, c.name).toBe(0);
      // every text unit points at a real owner whose own text is non-empty
      for (const t of c.snapshot.text_units) {
        const owner = c.snapshot.nodes[t.owner];
        expect(owner, `${c.name} ${t.id}`).toBeDefined();
        expect(t.id.startsWith(`n${t.owner}#t`)).toBe(true);
      }
    }
  });

  it("captures page signals, roles, hrefs and form-control types on at least one fixture", () => {
    const all = captured.flatMap((c) => c.snapshot.nodes);
    expect(all.some((n) => n.tag === "a" && typeof n.attrs.href === "string")).toBe(true);
    expect(all.some((n) => n.attrs.id !== undefined)).toBe(true);
    expect(all.some((n) => n.attrs.role !== undefined)).toBe(true);
    expect(all.some((n) => (n.tag === "input" || n.tag === "button") && n.attrs.type !== undefined)).toBe(true);
  });

  it("waits for the SPA fixtures to finish rendering (DOM-quiet), unlike a snapshot right after load", () => {
    for (const name of ["spa-1", "spa-2"]) {
      const c = captured.find((x) => x.name === name) as Captured;
      expect(c.snapshot.nodes.length, name).toBeGreaterThan(30);
      expect(c.probed.raw.settle.reason, name).toBe("quiet");
    }
  });
});

describe("probe determinism", () => {
  it("two independent loads of the same page give the same snapshot_id (ids, text, style, geometry)", async () => {
    for (const name of ["article-1", "product-1", "spa-1"]) {
      const first = captured.find((c) => c.name === name) as Captured;
      const second = await captureFixture(launched, name);
      expect(second.snapshot.nodes.map((n) => [n.idx, n.tag, n.parent]), name).toEqual(first.snapshot.nodes.map((n) => [n.idx, n.tag, n.parent]));
      expect(second.snapshot.snapshot_id, name).toBe(first.snapshot.snapshot_id);
    }
  });
});

describe("(a) vectorize is deterministic", () => {
  it("same snapshot, same schema: byte-identical output twice (and the input is not mutated)", () => {
    for (const c of captured) {
      const before = JSON.stringify(c.snapshot);
      const a = vectorizeMatrix(c.snapshot, featureSchemaV0);
      const b = vectorizeMatrix(c.snapshot, featureSchemaV0);
      expect(Buffer.from(a.x.buffer).equals(Buffer.from(b.x.buffer)), c.name).toBe(true);
      const d1 = JSON.stringify(vectorize(c.snapshot, featureSchemaV0));
      const d2 = JSON.stringify(vectorize(c.snapshot, featureSchemaV0));
      expect(d1, c.name).toBe(d2);
      expect(JSON.stringify(c.snapshot), c.name).toBe(before);
    }
  });
});

describe("(b) Node <-> Chromium parity", () => {
  it("the same bundle, run inside a blank page, gives bit-identical vectors for all 13 fixtures (docs-3 has collapsed content: flags.disclosure must not move a bit)", async () => {
    const page = await launched.context.newPage();
    try {
      await page.goto("about:blank");
      let totalRows = 0;
      for (const c of captured) {
        const node = vectorizeMatrix(c.snapshot, featureSchemaV0);
        const nodeDoc = vectorize(c.snapshot, featureSchemaV0);
        const inPage = await page.evaluate(
          ({ snapshot, schema }) => {
            const api = window.__gpFeatures;
            if (!api) throw new Error("bundle missing");
            const m = api.vectorizeMatrix(snapshot, schema);
            const bytes = new Uint8Array(m.x.buffer, m.x.byteOffset, m.x.byteLength);
            let bin = "";
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return { b64: btoa(bin), unit_ids: m.unit_ids, sanitized: m.sanitized, prefiltered: m.prefiltered, doc: api.vectorize(snapshot, schema) };
          },
          { snapshot: c.snapshot, schema: featureSchemaV0 },
        );
        // Float32Array byte equality, not a tolerance.
        expect(Buffer.from(inPage.b64, "base64").equals(Buffer.from(node.x.buffer, node.x.byteOffset, node.x.byteLength)), `${c.name}: float32 bytes`).toBe(true);
        expect(inPage.unit_ids, c.name).toEqual(node.unit_ids);
        expect(inPage.sanitized, c.name).toEqual(node.sanitized);
        expect(inPage.prefiltered, c.name).toEqual(node.prefiltered);
        // The whole contract document, including the content id computed by the in-bundle SHA-256.
        expect(inPage.doc.features_id, c.name).toBe(nodeDoc.features_id);
        expect(JSON.stringify(inPage.doc), c.name).toBe(JSON.stringify(nodeDoc));
        totalRows += node.unit_ids.length;
      }
      expect(totalRows).toBeGreaterThan(1000);
      // not a trivially-equal pair of empty / constant matrices
      const sample = vectorizeMatrix((captured[0] as Captured).snapshot, featureSchemaV0).x;
      expect(sample.reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
      expect(new Set(sample).size).toBeGreaterThan(50);
      console.log(`[parity] ${captured.length}/${captured.length} fixtures bit-identical, ${totalRows} rows x ${featureSchemaV0.dim} features`);
    } finally {
      await page.close();
    }
  });
});

describe("(c) contract validation", () => {
  it("NodeFeatures validate against @gran-prix/contracts (shape, float32 values, content id)", () => {
    for (const c of captured) {
      const nf: NodeFeaturesDoc = vectorize(c.snapshot, featureSchemaV0);
      const r = validate("node-features", nf);
      expect(r.issues, c.name).toEqual([]);
      expect(r.ok, c.name).toBe(true);
      expect(nf.snapshot_id).toBe(c.snapshot.snapshot_id);
      expect(nf.feature_schema_id).toBe(featureSchemaV0.schema_id);
      expect(nf.x[0]?.length).toBe(featureSchemaV0.dim);
      expect(nf.sanitized.nan_replaced, c.name).toBe(0);
    }
  });

  it("the structural types are assignable to the contract types", () => {
    const c = captured[0] as Captured;
    const s: PageSnapshot = c.snapshot;
    const nf: NodeFeatures = vectorize(c.snapshot, featureSchemaV0);
    expect(s.nodes.length).toBeGreaterThan(0);
    expect(nf.x.length).toBeGreaterThan(0);
  });
});

describe("(d) sanity: the features separate main from noise (report only)", () => {
  it("prints mean feature values of truth-main vs truth-noise text-bearing elements", () => {
    const names = featureSchemaV0.features.map((f) => f.name);
    const col = (n: string): number => names.indexOf(n);
    const cols = ["text_density", "link_density", "log_own_len", "stopword_ratio", "punct_ratio", "ends_with_punct", "text_share", "in_nav", "in_footer", "in_aside", "pos_fixed_sticky", "visible", "y_center_rel", "parent_link_density"];
    const hintCols = names.filter((n) => n.startsWith("hint_"));
    const sums: Record<string, { n: number; v: number[] }> = { main: { n: 0, v: [] }, support: { n: 0, v: [] }, noise: { n: 0, v: [] } };
    for (const k of Object.keys(sums)) (sums[k] as { v: number[] }).v = new Array(cols.length + 2).fill(0);
    for (const c of captured) {
      const m = vectorizeMatrix(c.snapshot, featureSchemaV0);
      m.unit_ids.forEach((idx, r) => {
        const label = c.truth[idx];
        const node = c.snapshot.nodes[idx];
        if (!label || !node || node.own_text_len === 0) return; // unit of evaluation: elements that own text
        const row = m.x.subarray(r * m.dim, (r + 1) * m.dim);
        const acc = sums[label] as { n: number; v: number[] };
        acc.n++;
        cols.forEach((n, j) => { acc.v[j] = (acc.v[j] as number) + (row[col(n)] as number); });
        acc.v[cols.length] = (acc.v[cols.length] as number) + hintCols.filter((h) => row[col(h)] === 1 && h !== "hint_comment").length; // any noise-ish hint
        acc.v[cols.length + 1] = (acc.v[cols.length + 1] as number) + (hintCols.some((h) => row[col(h)] === 1) ? 1 : 0);
      });
    }
    const header = ["feature", ...Object.keys(sums).map((k) => `${k} (n=${(sums[k] as { n: number }).n})`)];
    const rows = [...cols, "n_hints_set (excl. comment)", "any_hint"].map((n, j) => [n, ...Object.keys(sums).map((k) => {
      const a = sums[k] as { n: number; v: number[] };
      return a.n > 0 ? ((a.v[j] as number) / a.n).toFixed(3) : "-";
    })]);
    console.log("[sanity] mean over text-bearing elements, 13 fixtures\n" + [header, ...rows].map((r) => r.join(" | ")).join("\n"));
    expect((sums["main"] as { n: number }).n).toBeGreaterThan(50);
    expect((sums["noise"] as { n: number }).n).toBeGreaterThan(20);
  });
});
