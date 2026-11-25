import { Type, type Static } from "@sinclair/typebox";
import { FileRef, Iso8601, NonNegInt, PosInt, SemVer, Sha256, contractObject, defineContract } from "./base.js";

/**
 * PageSnapshot (DOM-specific): the durable raw material of a page. Features are
 * derived from it, so changing the feature schema never needs a re-crawl.
 * `snapshot_id` hashes everything except `capture`.
 *
 * NORMATIVE (v1.1) - composed-tree pre-order and ids. Every producer (collector, extension, labelers) must
 * number elements the same way, otherwise labels do not line up with features. The traversal is
 *
 *     visit(element) -> children of its OPEN shadow root, in order -> its light-DOM children, in order
 *
 * (element first, then the shadow root's children, then the light children; recursively). Element id =
 * pre-order index `k`: `nodes[k].idx === k`, DOM attribute `data-gp-id="n<k>"`, text-unit owner = `k`.
 * The parent of a node inside a shadow root is the shadow host. NOT entered: iframe documents (the
 * `<iframe>` element itself is a node), closed shadow roots, `<template>` content, text nodes sitting
 * directly in a shadow root. Ids are valid for ONE snapshot only (a re-collection may renumber).
 *
 * NORMATIVE (v1.1) - the `html` FileRef. The referenced file is the FLATTENED rendered HTML, gzip
 * (media_type `application/gzip`): open shadow roots inlined, `data-gp-id` attributes KEPT (they are the join
 * key between the markup and `nodes`), `<script>` removed. It is the input of DOM-clone based labelers. It is
 * not the HTML the server sent, and, because scripts are removed, a D1 token count taken from it (protocol
 * experimento-dom-v0 section 10 counts inline scripts) must be defined by the stage that computes it.
 */

/** Pre-order composed-tree id scheme this contract version defines. */
export const ID_SCHEME = "gp-composed-preorder/1";

export const SnapNode = Type.Object({
  idx: NonNegInt,
  parent: Type.Integer({ minimum: -1, description: "-1 for the root; otherwise < idx (pre-order)." }),
  depth: NonNegInt,
  tag: Type.String({ minLength: 1, description: "Lowercase tag name." }),
  attrs: Type.Object(
    {
      id: Type.Optional(Type.String({ description: "id attribute, verbatim (probe cap: 128 UTF-16 units)." })),
      class: Type.Optional(Type.String({ description: "class attribute, verbatim (probe cap 512)." })),
      role: Type.Optional(Type.String({ description: "ARIA role attribute, verbatim (probe cap 64); NOT the implicit role." })),
      href: Type.Optional(Type.String({ description: "href attribute as written (not resolved against the base URL; probe cap 512)." })),
      type: Type.Optional(
        Type.String({ description: "type attribute; for input/button/select/textarea the effective property, i.e. the implicit default ('text', 'submit', ...) when the attribute is absent (probe cap 32)." }),
      ),
      "aria-label": Type.Optional(Type.String()),
      itemprop: Type.Optional(Type.String()),
      alt: Type.Optional(Type.String()),
      src: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
    },
    { description: "Whitelisted attributes only (whitelist is fixed per probe version). Absent = missing or empty." },
  ),
  own_text: Type.String({ description: "Direct text children, whitespace collapsed, truncated to probe.own_text_cap UTF-16 units." }),
  own_text_len: NonNegInt,
  text_len: NonNegInt,
  link_text_len: NonNegInt,
  child_elems: NonNegInt,
  style: Type.Object({
    display: Type.String(),
    visibility: Type.String(),
    opacity: Type.Number({ minimum: 0, maximum: 1 }),
    position: Type.String(),
    font_size: Type.Number({ minimum: 0 }),
    font_weight: Type.Number({ minimum: 0 }),
    float: Type.Optional(Type.String()),
    z_index: Type.Optional(Type.Integer()),
  }),
  rect: Type.Union([
    Type.Object({ x: Type.Integer(), y: Type.Integer(), w: Type.Integer({ minimum: 0 }), h: Type.Integer({ minimum: 0 }) }),
    Type.Null(),
  ]),
  flags: Type.Object({
    in_shadow: Type.Boolean(),
    iframe_depth: NonNegInt,
    disclosure: Type.Optional(
      Type.Boolean({
        description:
          "v1.1 (C12): the element sits inside a COLLAPSED disclosure (closed <details>, aria-expanded=false region, inactive role=tabpanel). Not rendered, but part of the labelable universe U. Absent = false.",
      }),
    ),
  }),
});
export type SnapNode = Static<typeof SnapNode>;

/** A non-blank light-DOM text node, addressed `<owner id>#t<child index among the owner's childNodes>`. */
export const TextUnit = Type.Object({
  id: Type.String({ pattern: "^n[0-9]+#t[0-9]+$", description: "e.g. n9#t2: the 3rd child node of element n9." }),
  owner: NonNegInt,
  t: Type.String({ description: "Raw node value (not collapsed), well-formed UTF-16." }),
});
export type TextUnit = Static<typeof TextUnit>;

/** Deterministic facts about HOW the snapshot was produced; part of the snapshot identity. */
export const ProbeInfo = Type.Object({
  id_scheme: Type.Literal(ID_SCHEME, { description: "Traversal and id format; see the header of this module." }),
  version: SemVer,
  own_text_cap: PosInt,
});
export type ProbeInfo = Static<typeof ProbeInfo>;

export const SettleRecord = Type.Object({
  reason: Type.Union([Type.Literal("quiet"), Type.Literal("max"), Type.Literal("skipped")]),
  waited_ms: Type.Number({ minimum: 0 }),
  mutations: NonNegInt,
  shadow_roots: NonNegInt,
  tracked_from_start: Type.Boolean(),
  late_unstamped: Type.Optional(NonNegInt),
});
export type SettleRecord = Static<typeof SettleRecord>;

export const PageSnapshotContract = defineContract(
  "page-snapshot",
  "gran-prix.page-snapshot",
  "1.1.0",
  contractObject(
    "page-snapshot",
    "gran-prix.page-snapshot",
    {
      snapshot_id: Sha256,
      page: Type.Object({
        url: Type.String({ minLength: 1 }),
        final_url: Type.String({ minLength: 1 }),
        url_key: Type.String({ minLength: 1, description: "Normalized URL: no fragment/tracking params, lowercase host." }),
        group_key: Type.String({ minLength: 1, description: "Registrable domain (eTLD+1): unit of the anti-leakage split." }),
        category: Type.String({ minLength: 1, description: "Stratum of the page (article, ecom, docs, ...)." }),
        title: Type.Optional(Type.String()),
        lang: Type.Optional(Type.String()),
        og_type: Type.Optional(Type.String({ description: "v1.1: <meta property=og:type> of the light DOM, verbatim." })),
        jsonld_types: Type.Optional(
          Type.Array(Type.String(), { description: "v1.1: distinct JSON-LD @type values (document order, capped by the probe)." }),
        ),
      }),
      doc: Type.Object({
        viewport_w: NonNegInt,
        viewport_h: NonNegInt,
        scroll_w: NonNegInt,
        scroll_h: NonNegInt,
      }),
      nodes: Type.Array(SnapNode, {
        description: "Composed-tree pre-order element table (see the module header); nodes[i].idx === i.",
      }),
      text_units: Type.Optional(
        Type.Array(TextUnit, {
          description:
            "v1.1: every non-blank light-DOM text node (script/style/noscript/template text excluded), interleaved in composed document order. Per owner, the child index strictly increases.",
        }),
      ),
      probe: Type.Optional(ProbeInfo),
      html: FileRef,
      capture: Type.Object(
        {
          captured_at: Iso8601,
          collector_version: Type.String(),
          browser: Type.Object({ name: Type.Literal("chromium"), version: Type.String() }),
          user_agent: Type.String(),
          http_status: Type.Integer({ minimum: 100, maximum: 599 }),
          wait_strategy: Type.String(),
          scrolled_to_bottom: Type.Boolean(),
          truncated: Type.Boolean(),
          auth: Type.Literal("none"),
          settle: Type.Optional(SettleRecord),
          network: Type.Optional(
            Type.Union([Type.Literal("idle"), Type.Literal("timeout"), Type.Literal("skipped")], {
              description: "v1.1: outcome of the best-effort networkidle wait (idle = reached, timeout = capped, skipped = not attempted).",
            }),
          ),
        },
        { description: "Capture metadata. OUTSIDE snapshot_id." },
      ),
    },
    "Immutable record of a rendered page: composed-tree pre-order node table + text units + flattened HTML reference. v1.1 makes the id scheme, text units, disclosure flag and settle record part of the contract.",
  ),
);
export const PageSnapshotSchema = PageSnapshotContract.schema;
export type PageSnapshot = Static<typeof PageSnapshotSchema>;
