import { Type, type Static } from "@sinclair/typebox";
import { FileRef, Iso8601, NonNegInt, Sha256, contractObject, defineContract } from "./base.js";

/**
 * PageSnapshot (DOM-specific): the durable raw material of a page. Features are
 * derived from it, so changing the feature schema never needs a re-crawl.
 * `snapshot_id` hashes everything except `capture`.
 */

export const SnapNode = Type.Object({
  idx: NonNegInt,
  parent: Type.Integer({ minimum: -1, description: "-1 for the root; otherwise < idx (pre-order)." }),
  depth: NonNegInt,
  tag: Type.String({ minLength: 1, description: "Lowercase tag name." }),
  attrs: Type.Object(
    {
      id: Type.Optional(Type.String()),
      class: Type.Optional(Type.String()),
      role: Type.Optional(Type.String()),
      href: Type.Optional(Type.String()),
      type: Type.Optional(Type.String()),
      "aria-label": Type.Optional(Type.String()),
      itemprop: Type.Optional(Type.String()),
      alt: Type.Optional(Type.String()),
      src: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
    },
    { description: "Whitelisted attributes only (whitelist is fixed per collector_version)." },
  ),
  own_text: Type.String({ description: "Direct text children, whitespace collapsed, truncated." }),
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
  flags: Type.Object({ in_shadow: Type.Boolean(), iframe_depth: NonNegInt }),
});
export type SnapNode = Static<typeof SnapNode>;

export const PageSnapshotContract = defineContract(
  "page-snapshot",
  "gran-prix.page-snapshot",
  "1.0.0",
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
      }),
      doc: Type.Object({
        viewport_w: NonNegInt,
        viewport_h: NonNegInt,
        scroll_w: NonNegInt,
        scroll_h: NonNegInt,
      }),
      nodes: Type.Array(SnapNode, { description: "Pre-order element table; nodes[i].idx === i." }),
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
        },
        { description: "Capture metadata. OUTSIDE snapshot_id." },
      ),
    },
    "Immutable record of a rendered page: flat pre-order node table + rendered HTML reference.",
  ),
);
export const PageSnapshotSchema = PageSnapshotContract.schema;
export type PageSnapshot = Static<typeof PageSnapshotSchema>;
