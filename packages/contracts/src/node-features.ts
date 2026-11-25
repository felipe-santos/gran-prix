import { Type, type Static } from "@sinclair/typebox";
import { NonNegInt, SemVer, Sha256, contractObject, defineContract } from "./base.js";

/**
 * NodeFeatures (DOM-specific): the output of `extract(snapshot, schema)`.
 * One row per classifiable unit; every value is already a float32 (`Math.fround`).
 */
export const NodeFeaturesContract = defineContract(
  "node-features",
  "gran-prix.node-features",
  "1.0.0",
  contractObject(
    "node-features",
    "gran-prix.node-features",
    {
      features_id: Sha256,
      snapshot_id: Sha256,
      feature_schema_id: Sha256,
      extractor: Type.Object({ name: Type.String({ minLength: 1 }), version: SemVer }),
      n_nodes_total: NonNegInt,
      prefiltered: Type.Record(Type.String(), NonNegInt, { description: "Count of nodes dropped per prefilter rule id." }),
      sanitized: Type.Object({ nan_replaced: NonNegInt, clipped: NonNegInt }),
      unit_ids: Type.Array(NonNegInt, { description: "Snapshot node idx per row, strictly increasing." }),
      x: Type.Array(Type.Array(Type.Number()), {
        description: "x[r].length === schema.dim; finite float32 values.",
      }),
    },
    "Feature matrix of one snapshot under one feature schema.",
  ),
);
export const NodeFeaturesSchema = NodeFeaturesContract.schema;
export type NodeFeatures = Static<typeof NodeFeaturesSchema>;
