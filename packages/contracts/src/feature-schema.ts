import { Type, type Static } from "@sinclair/typebox";
import { NonNegInt, PosInt, SemVer, Sha256, SnakeName, contractObject, defineContract } from "./base.js";

/**
 * FeatureSchema: immutable, hash-identified description of the feature vector.
 * Models bind to `schema_id` exactly; there is no "compatible schema" notion.
 * Only STATIC normalization lives here; fitted z-score lives in the ModelPackage.
 */

export const StaticTransform = Type.Union([
  Type.Object({ op: Type.Literal("none") }),
  Type.Object({ op: Type.Literal("log1p"), scale: Type.Number({ exclusiveMinimum: 0 }) }),
  Type.Object({ op: Type.Literal("clip"), lo: Type.Number(), hi: Type.Number() }),
  Type.Object({ op: Type.Literal("div"), by: Type.Number({ description: "Non-zero divisor." }) }),
]);
export type StaticTransform = Static<typeof StaticTransform>;

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
});
export type FeatureDef = Static<typeof FeatureDef>;

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
  "1.0.0",
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
