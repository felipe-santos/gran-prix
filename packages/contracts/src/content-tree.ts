import { Type, type Static } from "@sinclair/typebox";
import { NonNegInt, Sha256, contractObject, defineContract } from "./base.js";

/**
 * ContentTree (DOM-specific): the pruned document the `infer` stage emits.
 * Renderers (markdown, json, preview) are pure `ContentTree -> string`
 * functions; plain text of a node is derived from `runs`, never duplicated.
 *
 * The recursive parts live in `$defs` and are referenced with `$ref`, so the
 * emitted JSON Schema is self-contained and Rust-friendly.
 */

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "link"; href: string; children: Inline[] }
  | { t: "strong" | "em"; children: Inline[] };

interface NodeBase {
  /** Snapshot unit ids that produced this node (for reverse feedback). */
  src: number[];
  score?: number;
}
export type ContentNode = NodeBase &
  (
    | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; runs: Inline[] }
    | { kind: "paragraph"; runs: Inline[] }
    | { kind: "list"; ordered: boolean; items: ContentNode[] }
    | { kind: "table"; headers: string[]; rows: string[][] }
    | { kind: "code"; lang: string | null; text: string }
    | { kind: "quote"; children: ContentNode[] }
    | { kind: "media"; alt: string; url: string }
    | { kind: "container"; children: ContentNode[] }
  );

const InlineRef = Type.Unsafe<Inline>({ $ref: "#/$defs/Inline" });
const NodeRef = Type.Unsafe<ContentNode>({ $ref: "#/$defs/ContentNode" });

const InlineDef = Type.Union([
  Type.Object({ t: Type.Literal("text"), text: Type.String() }),
  Type.Object({ t: Type.Literal("code"), text: Type.String() }),
  Type.Object({ t: Type.Literal("link"), href: Type.String(), children: Type.Array(InlineRef) }),
  Type.Object({ t: Type.Union([Type.Literal("strong"), Type.Literal("em")]), children: Type.Array(InlineRef) }),
]);

const base = { src: Type.Array(NonNegInt), score: Type.Optional(Type.Number()) };

const NodeDef = Type.Union([
  Type.Object({
    ...base,
    kind: Type.Literal("heading"),
    level: Type.Union([1, 2, 3, 4, 5, 6].map((n) => Type.Literal(n))),
    runs: Type.Array(InlineRef),
  }),
  Type.Object({ ...base, kind: Type.Literal("paragraph"), runs: Type.Array(InlineRef) }),
  Type.Object({ ...base, kind: Type.Literal("list"), ordered: Type.Boolean(), items: Type.Array(NodeRef) }),
  Type.Object({
    ...base,
    kind: Type.Literal("table"),
    headers: Type.Array(Type.String()),
    rows: Type.Array(Type.Array(Type.String())),
  }),
  Type.Object({ ...base, kind: Type.Literal("code"), lang: Type.Union([Type.String(), Type.Null()]), text: Type.String() }),
  Type.Object({ ...base, kind: Type.Literal("quote"), children: Type.Array(NodeRef) }),
  Type.Object({ ...base, kind: Type.Literal("media"), alt: Type.String(), url: Type.String() }),
  Type.Object({ ...base, kind: Type.Literal("container"), children: Type.Array(NodeRef) }),
]);

export const ContentTreeContract = defineContract(
  "content-tree",
  "gran-prix.content-tree",
  "1.0.0",
  contractObject(
    "content-tree",
    "gran-prix.content-tree",
    {
      source: Type.Object({
        url: Type.String({ minLength: 1 }),
        snapshot_id: Type.Optional(Sha256),
        model_id: Sha256,
        feature_schema_id: Sha256,
        threshold: Type.Number({ minimum: 0, maximum: 1 }),
        mode: Type.Union([
          Type.Literal("aggressive"),
          Type.Literal("balanced"),
          Type.Literal("strict"),
          Type.Literal("custom"),
        ]),
      }),
      root: Type.Array(NodeRef),
      stats: Type.Object({
        nodes_total: NonNegInt,
        nodes_candidates: NonNegInt,
        nodes_kept: NonNegInt,
        chars_in: NonNegInt,
        chars_out: NonNegInt,
      }),
    },
    "Pruned content of a page: block tree with inline runs and back-references to snapshot units.",
    { $defs: { Inline: InlineDef, ContentNode: NodeDef } },
  ),
);
export const ContentTreeSchema = ContentTreeContract.schema;
export type ContentTree = Static<typeof ContentTreeSchema>;
