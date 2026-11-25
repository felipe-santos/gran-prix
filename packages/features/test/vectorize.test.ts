// Unit tests of the pure vectorizer on a hand-built snapshot (no browser).
import { artifactId, canonicalJson, contractId, sha256Hex, validate } from "@gran-prix/contracts";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  VectorizeError, artifactId as pureArtifactId, canonicalJson as pureCanonical, featureSchemaV0, fnv1a32, hintBits,
  idClassTokens, sha256Hex as pureSha, vectorize, vectorizeMatrix,
  type FeatureSchemaLike, type SnapNodeLike, type SnapshotLike,
} from "../src/index.js";

const SNAP_ID = `sha256:${"a".repeat(64)}` as const;
const col = (name: string): number => featureSchemaV0.features.findIndex((f) => f.name === name);

interface Spec {
  tag: string;
  parent: number;
  own?: string;
  attrs?: SnapNodeLike["attrs"];
  display?: string;
  rect?: SnapNodeLike["rect"];
  style?: Partial<SnapNodeLike["style"]>;
}

/** Builds a pre-order node table with consistent depth, subtree text and link text lengths. */
function build(specs: Spec[], page: SnapshotLike["page"] = {}): SnapshotLike {
  const nodes: SnapNodeLike[] = specs.map((s, idx) => ({
    idx,
    parent: s.parent,
    depth: s.parent < 0 ? 0 : 0,
    tag: s.tag,
    attrs: s.attrs ?? {},
    own_text: s.own ?? "",
    own_text_len: (s.own ?? "").length,
    text_len: 0,
    link_text_len: 0,
    child_elems: 0,
    style: { display: s.display ?? "block", visibility: "visible", opacity: 1, position: "static", font_size: 16, font_weight: 400, ...s.style },
    rect: s.rect === undefined ? { x: 0, y: idx * 20, w: 400, h: 20 } : s.rect,
    flags: { in_shadow: false, iframe_depth: 0 },
  }));
  const inLink: boolean[] = [];
  nodes.forEach((n, i) => {
    const p = n.parent >= 0 ? (nodes[n.parent] as SnapNodeLike) : null;
    n.depth = p ? p.depth + 1 : 0;
    if (p) p.child_elems++;
    inLink[i] = n.tag === "a" || (n.parent >= 0 && (inLink[n.parent] as boolean));
  });
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i] as SnapNodeLike;
    n.text_len += n.own_text_len;
    if (inLink[i]) n.link_text_len += n.own_text_len;
    if (n.parent >= 0) {
      const p = nodes[n.parent] as SnapNodeLike;
      p.text_len += n.text_len;
      p.link_text_len += n.link_text_len;
    }
  }
  return {
    snapshot_id: SNAP_ID,
    page,
    doc: { viewport_w: 1280, viewport_h: 900, scroll_w: 1280, scroll_h: 2000 },
    nodes,
  };
}

const SAMPLE: Spec[] = [
  { tag: "html", parent: -1 }, //                                                   0
  { tag: "body", parent: 0 }, //                                                    1
  { tag: "nav", parent: 1, attrs: { class: "navbar main-menu" } }, //               2
  { tag: "a", parent: 2, own: "Home", attrs: { href: "/" } }, //                    3
  { tag: "div", parent: 1, attrs: { class: "content", id: "post-body" } }, //       4
  { tag: "p", parent: 4, own: "The quick brown fox jumps over the lazy dog. It is a good day." }, // 5
  { tag: "script", parent: 1, own: "var x = 1;" }, //                               6
  { tag: "div", parent: 1, display: "none", rect: null }, //                        7
  { tag: "p", parent: 7, own: "hidden text", rect: null }, //                       8
  { tag: "footer", parent: 1, attrs: { class: "site-footer" } }, //                 9
  { tag: "span", parent: 9, own: "(c) 2026" }, //                                   10
];

describe("vectorize on a hand-built snapshot", () => {
  const snap = build(SAMPLE);
  const m = vectorizeMatrix(snap, featureSchemaV0);
  const row = (idx: number): Float32Array => m.x.subarray(m.unit_ids.indexOf(idx) * m.dim, (m.unit_ids.indexOf(idx) + 1) * m.dim);
  const v = (idx: number, name: string): number => row(idx)[col(name)] as number;

  it("prefilters script tags and display:none subtrees (the subtree inherits the rule) and keeps context nodes", () => {
    expect(m.unit_ids).toEqual([0, 1, 2, 3, 4, 5, 9, 10]);
    expect(m.prefiltered).toEqual({ skip_tags: 1, display_none: 2 });
    expect(m.n_nodes_total).toBe(11);
    expect(m.dim).toBe(featureSchemaV0.dim);
    expect(m.x.length).toBe(8 * featureSchemaV0.dim);
  });

  it("computes text, link and structure features", () => {
    expect(v(3, "link_density")).toBe(1);
    expect(v(5, "link_density")).toBe(0);
    expect(v(2, "link_density")).toBe(1); // <nav> text is all inside <a>
    expect(v(5, "tag_p")).toBe(1);
    expect(v(5, "tag_div")).toBe(0);
    expect(v(10, "tag_span")).toBe(1);
    expect(v(10, "tag_other")).toBe(0);
    expect(v(9, "tag_other")).toBe(1);
    expect(v(3, "in_link")).toBe(1);
    expect(v(5, "in_link")).toBe(0);
    expect(v(5, "ends_with_punct")).toBe(1);
    expect(v(5, "stopword_ratio")).toBeGreaterThan(0.2);
    expect(v(5, "punct_ratio")).toBeGreaterThan(0);
    const len = (SAMPLE[5] as Spec).own?.length ?? 0;
    expect(v(5, "text_density")).toBeCloseTo(Math.log1p(len) / Math.log1p(1000), 6); // one element holding len chars
    expect(v(5, "text_share")).toBeGreaterThan(0.5);
    // siblings of <div class=content> under <body>: nav, div, footer (script and display:none are not siblings)
    expect(v(4, "log_sibling_count")).toBeCloseTo(Math.log1p(3) / Math.log1p(100), 6);
    expect(v(4, "sibling_index_rel")).toBe(0.5);
    expect(v(2, "sibling_index_rel")).toBe(0);
    expect(v(9, "sibling_index_rel")).toBe(1);
  });

  it("computes landmark, hint and hash features, with ancestor-or-self propagation", () => {
    expect(v(3, "in_nav")).toBe(1);
    expect(v(5, "in_nav")).toBe(0);
    expect(v(10, "in_footer")).toBe(1);
    expect(v(2, "hint_nav")).toBe(1);
    expect(v(3, "hint_nav")).toBe(1); // inherited from <nav class=navbar>
    expect(v(3, "hint_menu")).toBe(1); // "main-menu" tokens: main, menu
    expect(v(10, "hint_footer")).toBe(1);
    expect(v(5, "hint_nav")).toBe(0);
    const hashed = ["idclass_hash_0", "idclass_hash_1", "idclass_hash_2", "idclass_hash_3"].reduce((a, n) => a + v(4, n), 0);
    expect(hashed).toBeGreaterThanOrEqual(1); // tokens: content, post, body
    expect(["idclass_hash_0", "idclass_hash_1", "idclass_hash_2", "idclass_hash_3"].reduce((a, n) => a + v(5, n), 0)).toBe(0);
  });

  it("copies the parent / previous / next sibling statistics into the context features", () => {
    expect(v(5, "parent_log_text_len")).toBe(v(4, "log_text_len"));
    expect(v(4, "prev_log_text_len")).toBe(v(2, "log_text_len"));
    expect(v(4, "prev_link_density")).toBe(1);
    expect(v(4, "next_log_text_len")).toBe(v(9, "log_text_len"));
    expect(v(0, "parent_log_text_len")).toBe(0); // root: default
    expect(v(2, "prev_log_text_len")).toBe(0); // no previous sibling
    expect(v(5, "next_link_density")).toBe(0);
  });

  it("derives visibility and geometry", () => {
    expect(v(5, "visible")).toBe(1);
    expect(v(5, "area_frac")).toBeCloseTo((400 * 20) / (1280 * 2000), 6);
    expect(v(5, "font_size_rel")).toBe(1);
    expect(v(5, "font_weight_rel")).toBeCloseTo(400 / 900, 6);
    const off = vectorizeMatrix(build([
      { tag: "html", parent: -1 }, { tag: "body", parent: 0 },
      { tag: "p", parent: 1, own: "x", rect: { x: -5000, y: 0, w: 100, h: 10 } },
      { tag: "p", parent: 1, own: "y", style: { opacity: 0 } },
      { tag: "div", parent: 1, style: { position: "fixed" } },
    ]), featureSchemaV0);
    const get = (idx: number, name: string): number => off.x[off.unit_ids.indexOf(idx) * off.dim + col(name)] as number;
    expect(get(2, "visible")).toBe(0);
    expect(get(3, "visible")).toBe(0);
    expect(get(4, "pos_fixed_sticky")).toBe(1);
  });

  it("emits float32 values only, no NaN, no -0, all inside the declared ranges", () => {
    for (let r = 0; r < m.unit_ids.length; r++) {
      featureSchemaV0.features.forEach((f, c) => {
        const x = m.x[r * m.dim + c] as number;
        expect(Number.isFinite(x)).toBe(true);
        expect(Object.is(x, -0)).toBe(false);
        expect(Math.fround(x)).toBe(x);
        expect(x).toBeGreaterThanOrEqual(f.range[0]);
        expect(x).toBeLessThanOrEqual(f.range[1]);
      });
    }
    expect(m.sanitized).toEqual({ nan_replaced: 0, clipped: 0 });
  });

  it("counts clipped (out of range) values and replaces NaN", () => {
    const wild = build([{ tag: "html", parent: -1 }, { tag: "body", parent: 0, style: { font_weight: 100000 } }]);
    const r = vectorizeMatrix(wild, featureSchemaV0);
    expect(r.sanitized.clipped).toBeGreaterThanOrEqual(1);
    const nan = build([{ tag: "html", parent: -1 }, { tag: "body", parent: 0, style: { font_size: Number.NaN } }]);
    expect(vectorizeMatrix(nan, featureSchemaV0).sanitized.nan_replaced).toBeGreaterThanOrEqual(1);
  });

  it("page-type features follow og:type and JSON-LD @type", () => {
    const get = (page: SnapshotLike["page"], name: string): number => {
      const s = build(SAMPLE, page);
      const r = vectorizeMatrix(s, featureSchemaV0);
      return r.x[col(name)] as number;
    };
    expect(get({ og_type: "article" }, "page_article")).toBe(1);
    expect(get({ jsonld_types: ["NewsArticle"] }, "page_article")).toBe(1);
    expect(get({ jsonld_types: ["https://schema.org/Product"] }, "page_product")).toBe(1);
    expect(get({ og_type: "og:product" }, "page_product")).toBe(1);
    expect(get({ jsonld_types: ["DiscussionForumPosting"] }, "page_discussion")).toBe(1);
    expect(get({}, "page_article") + get({}, "page_product") + get({}, "page_discussion")).toBe(0);
  });

  it("refuses schemas it cannot honour instead of guessing", () => {
    const unknown: FeatureSchemaLike = { ...featureSchemaV0, features: [{ ...featureSchemaV0.features[0]!, name: "not_a_feature" }], dim: 1 };
    expect(() => vectorizeMatrix(snap, unknown)).toThrow(VectorizeError);
    const noSource: FeatureSchemaLike = { ...featureSchemaV0, features: featureSchemaV0.features.filter((f) => f.name !== "log_text_len").map((f, i) => ({ ...f, index: i })), dim: 58 };
    expect(() => vectorizeMatrix(snap, noSource)).toThrow(/needs source feature/);
  });

  it("validates as a contract NodeFeatures document", () => {
    const r = validate("node-features", vectorize(snap, featureSchemaV0));
    expect(r.issues).toEqual([]);
  });
});

describe("pure helpers agree with the reference implementations", () => {
  it("fnv1a32 matches the published test vectors and is UTF-8 based", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
    // "é" is 0xC3 0xA9 in UTF-8
    let h = 0x811c9dc5;
    for (const b of [0xc3, 0xa9]) h = Math.imul(h ^ b, 0x01000193) >>> 0;
    expect(fnv1a32("é")).toBe(h);
  });

  it("SHA-256 and canonical JSON equal the contracts' implementations", () => {
    for (const s of ["", "abc", "x".repeat(1000), "naïve ✓ 😀", JSON.stringify({ a: 1 })]) expect(pureSha(s)).toBe(sha256Hex(s));
    const doc = { b: [1.5, -0, 0.1 + 0.2, 1e21, 5e-7], a: { z: null, y: "q \n\"", x: true }, u: undefined, "é": 1 };
    expect(pureCanonical(doc)).toBe(canonicalJson(doc));
    expect(pureArtifactId(doc)).toBe(artifactId(doc));
  });

  it("the content id vectorize computes equals contractId('node-features')", () => {
    const nf = vectorize(build(SAMPLE), featureSchemaV0);
    expect(nf.features_id).toBe(contractId("node-features", nf as unknown as Record<string, unknown>));
  });

  it("id/class tokenization and hints", () => {
    expect(idClassTokens("mainNav sidebar-left item-12 a")).toEqual(["main", "nav", "sidebar", "left", "item"]);
    expect(hintBits(idClassTokens("cookie-consent-banner")) & (1 << 5)).not.toBe(0);
    expect(hintBits(idClassTokens("headline article-body"))).toBe(0);
    expect(hintBits(idClassTokens("advanced-search"))).toBe(0); // "advanced" is not an ad token
  });
});

describe("purity of src/vectorize", () => {
  const dir = fileURLToPath(new URL("../src/vectorize/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  it("never touches the clock, randomness, the DOM or the environment", () => {
    expect(files.length).toBeGreaterThan(5);
    const forbidden = /\b(Date|Math\.random|performance|document|window|globalThis|process|require|crypto|fetch|localStorage|setTimeout|Intl|toLocale\w*)\b/;
    for (const f of files) {
      const code = readFileSync(dir + f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(forbidden.exec(code.replace(/"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""')), f).toBeNull();
    }
  });
});
