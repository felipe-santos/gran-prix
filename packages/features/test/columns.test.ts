// vectorize/columns.ts (plain loops, used by the page) must compute exactly what FeatureSpec.raw (the definition) does,
// for every feature of FeatureSchema v0, on random snapshots; and no feature of the schema may fall back to the closures.
import { describe, expect, it } from "vitest";
import { FEATURE_SPECS, featureSchemaV0, type SnapNodeLike, type SnapshotLike } from "../src/index.js";
import { derive } from "../src/vectorize/derive.js";
import { fillRawColumn } from "../src/vectorize/columns.js";

let seed = 77;
const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T;

const TAGS = ["div", "p", "span", "a", "li", "h1", "h3", "h6", "section", "nav", "header", "footer", "aside", "main", "script", "style", "ul", "img", "td", "article"];
const CLASSES = ["", "nav-bar", "AdSlot", "post body", "comment-list", "sidebar", "menuItem share", "cookieConsent", "related", "col-md-6", "footer", "x"];
const TEXTS = ["", "", "Hello, world.", "The quick brown fox jumps over the lazy dog.", "(c) 2026 all rights", "Read more...", "Ünïcode ünïcode.", "x"];

function randomSnapshot(n: number): SnapshotLike {
  const nodes: SnapNodeLike[] = [];
  for (let idx = 0; idx < n; idx++) {
    const parent = idx === 0 ? -1 : Math.floor(rnd() * idx);
    const text = pick(TEXTS);
    const w = Math.floor(rnd() * 600);
    nodes.push({
      idx, parent, depth: 0, tag: idx === 0 ? "html" : pick(TAGS),
      attrs: { ...(rnd() < 0.5 ? { class: pick(CLASSES) } : {}), ...(rnd() < 0.2 ? { id: pick(CLASSES) } : {}), ...(rnd() < 0.1 ? { role: pick(["main", "navigation", "banner", "contentinfo", "complementary"]) } : {}) },
      own_text: text, own_text_len: rnd() < 0.2 ? text.length + 30 : text.length, text_len: 0, link_text_len: 0, child_elems: 0,
      style: {
        display: pick(["block", "inline", "none", "contents", "flex"]), visibility: pick(["visible", "visible", "hidden"]),
        opacity: pick([1, 1, 1, 0.5, 0]), position: pick(["static", "static", "fixed", "sticky", "absolute"]),
        font_size: pick([0, 12, 14, 16, 16, 24, 48]), font_weight: pick([400, 400, 700, 900]),
      },
      rect: rnd() < 0.1 ? null : { x: Math.floor(rnd() * 1200) - 100, y: Math.floor(rnd() * 3000) - 50, w, h: Math.floor(rnd() * 300) },
      flags: { in_shadow: false, iframe_depth: 0 },
    });
  }
  for (const nd of nodes) nd.depth = nd.parent < 0 ? 0 : (nodes[nd.parent] as SnapNodeLike).depth + 1;
  for (let i = n - 1; i >= 0; i--) {
    const nd = nodes[i] as SnapNodeLike;
    nd.text_len += nd.own_text_len;
    if (nd.tag === "a") nd.link_text_len += nd.own_text_len;
    if (nd.parent >= 0) { const p = nodes[nd.parent] as SnapNodeLike; p.text_len += nd.text_len; p.link_text_len += nd.link_text_len; }
  }
  const page = rnd() < 0.5 ? { og_type: pick(["article", "product", "website"]), jsonld_types: [pick(["Article", "Product", "QAPage", "WebSite"])] } : {};
  return { snapshot_id: `sha256:${"b".repeat(64)}`, page, doc: { viewport_w: 1280, viewport_h: 900, scroll_w: pick([1280, 1500, 0]), scroll_h: pick([2000, 9000, 0]) }, nodes };
}

describe("fillRawColumn = FeatureSpec.raw", () => {
  it("knows every non-context feature of FeatureSchema v0", () => {
    const ctx = derive(randomSnapshot(40), featureSchemaV0);
    const out = new Float64Array(1);
    for (const spec of FEATURE_SPECS) if (spec.raw) expect(fillRawColumn(spec.name, ctx, [0], out), spec.name).toBe(true);
    expect(fillRawColumn("not_a_feature", ctx, [0], out)).toBe(false);
    expect(fillRawColumn("hint_nothing", ctx, [0], out)).toBe(false);
    expect(fillRawColumn("constructor", ctx, [0], out)).toBe(false);
  });

  it("gives the same numbers, bit for bit, on random snapshots (all rows, and a subset of rows)", () => {
    for (let k = 0; k < 40; k++) {
      const snap = randomSnapshot(30 + Math.floor(rnd() * 200));
      const ctx = derive(snap, featureSchemaV0);
      const all = Array.from({ length: snap.nodes.length }, (_, i) => i);
      const rows = [all, all.filter(() => rnd() < 0.6)];
      for (const r of rows) {
        const out = new Float64Array(r.length);
        for (const spec of FEATURE_SPECS) {
          if (!spec.raw) continue;
          expect(fillRawColumn(spec.name, ctx, r, out)).toBe(true);
          for (let j = 0; j < r.length; j++) {
            const want = spec.raw(ctx, r[j] as number) as number;
            expect(Object.is(out[j], want), `${spec.name} row ${j}: ${out[j]} vs ${want}`).toBe(true);
          }
        }
      }
    }
  });
});
