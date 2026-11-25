// Builds the FeatureSchema v0 document from the feature registry. The committed JSON file
// (src/schema/feature-schema.v0.json) must equal `buildFeatureSchemaV0()`; test/schema.test.ts checks
// it and regenerates it with UPDATE_SCHEMA=1 (`pnpm schema:regen`).
import { FEATURE_SPECS } from "./features.js";
import { artifactId } from "./hash.js";
import type { FeatureDefLike, FeatureSchemaLike, SemVerLike, Sha256Like } from "./types.js";

export const EXTRACTOR = { name: "@gran-prix/features", version: "0.1.0" } as const satisfies { name: string; version: SemVerLike };

export interface FeatureSchemaDoc extends FeatureSchemaLike {
  format: "gran-prix.feature-schema";
  format_version: "1.0.0";
  name: string;
  version: SemVerLike;
  unit: string;
  description: string;
}

/** Same exclusions as the contracts' `contractId("feature-schema", doc)`: schema_id, description, each feature's doc. */
export function featureSchemaId(doc: Omit<FeatureSchemaDoc, "schema_id"> & { schema_id?: string }): Sha256Like {
  const { schema_id: _id, description: _d, ...rest } = doc;
  void _id;
  void _d;
  return artifactId({ ...rest, features: doc.features.map(({ doc: _doc, ...f }) => { void _doc; return f; }) });
}

export function buildFeatureSchemaV0(): FeatureSchemaDoc {
  const features: FeatureDefLike[] = FEATURE_SPECS.map((s, index) => {
    const def: FeatureDefLike = {
      index, name: s.name, kind: s.kind, group: s.group, doc: s.doc,
      transform: s.transform, range: s.range, default: s.default, since: "0.1.0",
    };
    if (s.onehot) def.onehot = s.onehot;
    if (s.hash) def.hash = s.hash;
    if (s.context) def.context = s.context;
    return def;
  });
  const base = {
    format: "gran-prix.feature-schema" as const,
    format_version: "1.0.0" as const,
    name: "dom-node-v0",
    version: "0.1.0" as const,
    unit: "dom-element",
    description:
      "One row per rendered DOM element (script/style/head-like tags and display:none subtrees are prefiltered). " +
      "Own and subtree text statistics, structure, tag one-hot, landmarks, geometry, id/class hints and hashing, " +
      "page type, and the same core text statistics for the parent and the previous / next sibling. " +
      "Normalization is NOT fitted here; ranges are OOD clip bounds.",
    extractor: { ...EXTRACTOR },
    dim: features.length,
    features,
    prefilter: {
      rules_version: "1",
      rules: [
        { id: "skip_tags", kind: "tag" as const, tags: ["script", "style", "noscript", "template", "head", "meta", "link", "base", "title"] },
        { id: "display_none", kind: "style" as const, display_none: true as const },
      ],
    },
    missing_policy: { nan: "zero" as const, inf: "clip" as const },
  };
  return { schema_id: featureSchemaId(base), ...base };
}
