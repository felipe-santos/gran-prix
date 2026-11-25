import { Type, type Static } from "@sinclair/typebox";
import { NonNegInt, PosInt, SemVer, Sha256, SnakeName, contractObject, defineContract } from "./base.js";

/**
 * FeatureSchema: immutable, hash-identified description of the feature vector.
 * Models bind to `schema_id` exactly; there is no "compatible schema" notion.
 * Only STATIC normalization lives here; fitted z-score lives in the ModelPackage.
 */

/**
 * NORMATIVE (v1.1) transform semantics, applied to the RAW feature value `x`:
 *  - `none`:  x
 *  - `log1p`: log1p(x) / log1p(scale)   (so x = scale maps to 1; x >= 0 expected)
 *  - `clip`:  min(hi, max(lo, x))
 *  - `div`:   x / by
 * Then NaN -> 0, clip to `range` (counted in NodeFeatures.sanitized), then float32 rounding.
 */
export const StaticTransform = Type.Union([
  Type.Object({ op: Type.Literal("none") }),
  Type.Object({ op: Type.Literal("log1p"), scale: Type.Number({ exclusiveMinimum: 0, description: "log1p(x) / log1p(scale)." }) }),
  Type.Object({ op: Type.Literal("clip"), lo: Type.Number(), hi: Type.Number() }),
  Type.Object({ op: Type.Literal("div"), by: Type.Number({ description: "Non-zero divisor." }) }),
]);
export type StaticTransform = Static<typeof StaticTransform>;

export const ContextRel = Type.Union([Type.Literal("parent"), Type.Literal("prev"), Type.Literal("next")]);
export type ContextRel = Static<typeof ContextRel>;

export const FeatureDef = Type.Object({
  index: NonNegInt,
  name: SnakeName,
  kind: Type.Union([Type.Literal("scalar"), Type.Literal("bool"), Type.Literal("onehot"), Type.Literal("hash_bucket")]),
  group: Type.Optional(Type.String({ description: "text | structure | style | tag | class_hint | ..." })),
  doc: Type.String({ description: "Human documentation. NOT part of schema_id." }),
  transform: StaticTransform,
  range: Type.Tuple([Type.Number(), Type.Number()], {
    description: "[lo, hi] guaranteed by the extractor; also the OOD clip bounds (clipped values are counted in NodeFeatures.sanitized).",
  }),
  default: Type.Number({ description: "Value when the feature does not apply. Within range." }),
  since: SemVer,
  onehot: Type.Optional(Type.Object({ of: Type.String(), value: Type.String() })),
  hash: Type.Optional(Type.Object({ fn: Type.Literal("fnv1a32"), buckets: PosInt })),
  context: Type.Optional(
    Type.Object(
      { rel: ContextRel, source: SnakeName },
      {
        description:
          "v1.1: a context feature copies the FINISHED value (after transform and sanitize) of feature `source` at a related node: the parent, the previous or the next non-prefiltered sibling. Value = `default` when that node does not exist. `source` must be a non-context feature of the same schema.",
      },
    ),
  ),
});
export type FeatureDef = Static<typeof FeatureDef>;

/**
 * Prefilter rules decide which snapshot nodes are NOT rows of NodeFeatures. NORMATIVE (v1.1):
 *  - a `style` / `display_none` rule is a SUBTREE rule: a node with `display: none` is not rendered and neither
 *    is anything below it, so the whole subtree is dropped;
 *  - `tag`, `visibility_hidden` and `zero_rect` rules drop only the node that matches;
 *  - a prefiltered node is not a row and is not counted among its siblings (sibling features, context
 *    features); each node is counted once, under the first rule that drops it, in `NodeFeatures.prefiltered`.
 */
export const PrefilterRule = Type.Union([
  Type.Object({ id: Type.String({ minLength: 1 }), kind: Type.Literal("tag"), tags: Type.Array(Type.String(), { minItems: 1 }) }),
  Type.Object({ id: Type.String({ minLength: 1 }), kind: Type.Literal("style"), display_none: Type.Literal(true) }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    kind: Type.Union([Type.Literal("visibility_hidden"), Type.Literal("zero_rect")]),
  }),
]);
export type PrefilterRule = Static<typeof PrefilterRule>;

export const FeatureSchemaContract = defineContract(
  "feature-schema",
  "gran-prix.feature-schema",
  "1.1.0",
  contractObject(
    "feature-schema",
    "gran-prix.feature-schema",
    {
      schema_id: Sha256,
      name: Type.String({ minLength: 1 }),
      version: SemVer,
      unit: Type.String({ minLength: 1, description: "What one row represents, e.g. dom-node-own-content." }),
      description: Type.Optional(Type.String({ description: "NOT part of schema_id." })),
      extractor: Type.Object({ name: Type.String({ minLength: 1 }), version: SemVer }),
      dim: PosInt,
      features: Type.Array(FeatureDef, { minItems: 1, description: "features[i].index === i." }),
      prefilter: Type.Object({ rules_version: Type.String(), rules: Type.Array(PrefilterRule) }),
      missing_policy: Type.Object({ nan: Type.Literal("zero"), inf: Type.Literal("clip") }),
    },
    "Versioned, named features with stable indices and static transforms. Immutable, identified by schema_id.",
  ),
);
export const FeatureSchemaSchema = FeatureSchemaContract.schema;
export type FeatureSchema = Static<typeof FeatureSchemaSchema>;
