/**
 * Synthetic fixture documents for the extract side of the pipeline:
 * PageSnapshot, FeatureSchema, NodeFeatures, NodeLabels. No real page text.
 */
import type { FeatureSchema } from "../../feature-schema.js";
import { contractId } from "../../identity/contract-ids.js";
import { artifactId, sha256Of, type Sha256 } from "../../identity/hash.js";
import type { NodeFeatures } from "../../node-features.js";
import type { NodeLabels } from "../../node-labels.js";
import type { PageSnapshot, SnapNode } from "../../page-snapshot.js";

export const sha = (label: string): Sha256 => sha256Of(`fixture:${label}`);
const f32 = Math.fround;

const baseStyle = { display: "block", visibility: "visible", opacity: 1, position: "static", font_size: 16, font_weight: 400 };

function node(p: Partial<SnapNode> & Pick<SnapNode, "idx" | "parent" | "depth" | "tag">): SnapNode {
  return {
    attrs: {},
    own_text: "",
    own_text_len: 0,
    text_len: 0,
    link_text_len: 0,
    child_elems: 0,
    style: baseStyle,
    rect: { x: 0, y: 0, w: 800, h: 40 },
    flags: { in_shadow: false, iframe_depth: 0 },
    ...p,
  };
}

export function buildSnapshot(): PageSnapshot {
  const nodes: SnapNode[] = [
    node({ idx: 0, parent: -1, depth: 0, tag: "html", text_len: 62, link_text_len: 4, child_elems: 1, rect: { x: 0, y: 0, w: 1366, h: 900 } }),
    node({ idx: 1, parent: 0, depth: 1, tag: "body", text_len: 62, link_text_len: 4, child_elems: 5, rect: { x: 0, y: 0, w: 1366, h: 900 } }),
    node({
      idx: 2, parent: 1, depth: 2, tag: "h1", attrs: { id: "title" }, own_text: "Example heading", own_text_len: 15, text_len: 15,
      style: { ...baseStyle, font_size: 32, font_weight: 700 },
    }),
    node({
      idx: 3, parent: 1, depth: 2, tag: "p", own_text: "Synthetic paragraph text.", own_text_len: 25,
      text_len: 29, link_text_len: 4, child_elems: 1,
    }),
    node({
      idx: 4, parent: 3, depth: 3, tag: "a", attrs: { href: "/next", role: "link" }, own_text: "next", own_text_len: 4, text_len: 4,
      link_text_len: 4, style: { ...baseStyle, display: "inline" },
    }),
    // A form control: `type` is the effective property (the default "text" would be written when the attribute is absent).
    node({ idx: 5, parent: 1, depth: 2, tag: "input", attrs: { type: "search", name: "q", role: "searchbox" }, rect: { x: 10, y: 600, w: 300, h: 32 } }),
    // A collapsed <details>: its content is not rendered (no box) but belongs to the labelable universe (flags.disclosure).
    node({ idx: 6, parent: 1, depth: 2, tag: "details", text_len: 18, child_elems: 1, rect: { x: 10, y: 640, w: 600, h: 24 } }),
    node({
      idx: 7, parent: 6, depth: 3, tag: "p", own_text: "Hidden FAQ answer.", own_text_len: 18, text_len: 18, rect: null,
      flags: { in_shadow: false, iframe_depth: 0, disclosure: true },
    }),
    node({ idx: 8, parent: 1, depth: 2, tag: "script", style: { ...baseStyle, display: "none" }, rect: null }),
  ];
  const doc: PageSnapshot = {
    format: "gran-prix.page-snapshot",
    format_version: "1.1.0",
    snapshot_id: sha("placeholder"),
    page: {
      url: "https://a.example/post/1?utm_source=x",
      final_url: "https://a.example/post/1",
      url_key: "https://a.example/post/1",
      group_key: "a.example",
      category: "article",
      title: "Synthetic page",
      lang: "en",
      og_type: "article",
      jsonld_types: ["Article", "BreadcrumbList"],
    },
    doc: { viewport_w: 1366, viewport_h: 900, scroll_w: 1366, scroll_h: 1800 },
    nodes,
    text_units: [
      { id: "n2#t0", owner: 2, t: "Example heading" },
      { id: "n3#t0", owner: 3, t: "Synthetic paragraph text. " },
      { id: "n4#t0", owner: 4, t: "next" },
      { id: "n7#t0", owner: 7, t: "Hidden FAQ answer." },
    ],
    probe: { id_scheme: "gp-composed-preorder/1", version: "0.1.0", own_text_cap: 1000 },
    html: { path: "html/rendered.html.gz", sha256: sha("rendered-html"), bytes: 2048, media_type: "text/html", content_encoding: "gzip" },
    capture: {
      captured_at: "2026-11-25T12:00:00Z",
      collector_version: "0.1.0",
      browser: { name: "chromium", version: "130.0.0.0" },
      user_agent: "fixture",
      http_status: 200,
      wait_strategy: "networkidle+2s",
      scrolled_to_bottom: true,
      truncated: false,
      auth: "none",
      settle: { reason: "quiet", shadow_roots: 0, tracked_from_start: true, late_unstamped: 0 },
      flags: ["tiny-dom"],
      network: "idle",
    },
  };
  doc.snapshot_id = contractId("page-snapshot", doc);
  return doc;
}

export const FEATURE_NAMES = ["log_text_len", "link_density", "is_heading", "parent_link_density"] as const;

export function buildFeatureSchema(): FeatureSchema {
  const doc: FeatureSchema = {
    format: "gran-prix.feature-schema",
    format_version: "1.1.0",
    schema_id: sha("placeholder"),
    name: "dom-node-fixture",
    version: "1.0.0",
    unit: "dom-node-own-content",
    description: "Four-feature schema used only by the contract fixtures.",
    extractor: { name: "fixture-extractor", version: "0.1.0" },
    dim: 4,
    features: [
      { index: 0, name: "log_text_len", kind: "scalar", group: "text", doc: "log1p(text length) / log1p(10).", transform: { op: "log1p", scale: 10 }, range: [0, 1], default: 0, since: "1.0.0" },
      { index: 1, name: "link_density", kind: "scalar", group: "text", doc: "link_text_len / text_len.", transform: { op: "clip", lo: 0, hi: 1 }, range: [0, 1], default: 0, since: "1.0.0" },
      { index: 2, name: "is_heading", kind: "bool", group: "tag", doc: "1 for h1..h6.", transform: { op: "none" }, range: [0, 1], default: 0, since: "1.0.0" },
      {
        index: 3, name: "parent_link_density", kind: "scalar", group: "context", doc: "link_density of the parent (0 for the root).",
        transform: { op: "none" }, range: [0, 1], default: 0, since: "1.1.0", context: { rel: "parent", source: "link_density" },
      },
    ],
    prefilter: {
      rules_version: "1",
      rules: [
        { id: "skip_tags", kind: "tag", tags: ["script", "style", "noscript", "svg", "template"] },
        { id: "display_none", kind: "style", display_none: true },
        { id: "zero_rect", kind: "zero_rect" },
      ],
    },
    missing_policy: { nan: "zero", inf: "clip" },
  };
  doc.schema_id = contractId("feature-schema", doc);
  return doc;
}

/** Feature rows of units 2, 3, 4 of the fixture snapshot (float32 values). */
export const FEATURE_ROWS: number[][] = [
  [0.6, 0, 1, 0.0909].map(f32),
  [0.7, 0.1379, 0, 0.0909].map(f32),
  [0.3, 1, 0, 0.1379].map(f32),
];
export const FEATURE_UNITS = [2, 3, 4];

/** Rows of ALL non-prefiltered nodes of the fixture snapshot (every node but the <script> and the unrendered <p>). */
const OTHER_ROWS: Record<number, number[]> = {
  0: [0.9, 0.0645, 0, 0].map(f32),
  1: [0.9, 0.0645, 0, 0].map(f32),
  5: [0, 0, 0, 0.0645].map(f32),
  6: [0.4, 0, 0, 0.0645].map(f32),
};
export const FEATURE_UNITS_ALL = [0, 1, 2, 3, 4, 5, 6];
const rowOf = (u: number): number[] => (OTHER_ROWS[u] ?? (FEATURE_ROWS[FEATURE_UNITS.indexOf(u)] as number[]));

export function buildNodeFeatures(snapshot: PageSnapshot, schema: FeatureSchema): NodeFeatures {
  const doc: NodeFeatures = {
    format: "gran-prix.node-features",
    format_version: "1.0.1",
    features_id: sha("placeholder"),
    snapshot_id: snapshot.snapshot_id,
    feature_schema_id: schema.schema_id,
    extractor: schema.extractor,
    n_nodes_total: snapshot.nodes.length,
    // <script> (skip_tags; it is also display:none, but a node is counted once, under the first rule) and the unrendered <p> (zero_rect).
    prefiltered: { skip_tags: 1, display_none: 0, zero_rect: 1 },
    sanitized: { nan_replaced: 0, clipped: 0 },
    unit_ids: FEATURE_UNITS_ALL,
    x: FEATURE_UNITS_ALL.map(rowOf),
  };
  doc.features_id = contractId("node-features", doc);
  return doc;
}

export function buildNodeLabels(snapshot: PageSnapshot): NodeLabels {
  const doc: NodeLabels = {
    format: "gran-prix.node-labels",
    format_version: "1.0.0",
    labels_id: sha("placeholder"),
    snapshot_id: snapshot.snapshot_id,
    label_space: { kind: "multiclass", classes: ["main", "support", "noise"] },
    labeler: {
      id: "merge@1.0.0",
      kind: "merge",
      version: "1.0.0",
      params_sha256: artifactId({ priority: ["human", "llm", "heuristic"] }),
      inputs: [sha("labels-heuristic"), sha("labels-llm")],
    },
    items: [
      { unit_id: 2, y: 0, confidence: 1, source: "human", reason: "tag:h1" },
      { unit_id: 3, y: 0, confidence: 0.85, source: "llm", reason: "llm:[KEEP]" },
      { unit_id: 4, y: 1, confidence: 0.8, source: "heuristic", reason: "short-link-in-paragraph" },
      { unit_id: 7, y: 1, confidence: 0.5, source: "llm", reason: "doubt,collapsed" },
    ],
    coverage: { n_labeled: 4, n_candidates: 4 },
  };
  doc.labels_id = contractId("node-labels", doc);
  return doc;
}
