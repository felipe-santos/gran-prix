import { Type, type Static } from "@sinclair/typebox";
import { Iso8601, NonNegInt, SemVer, Sha256 } from "./base.js";

/**
 * Provenance sidecar (`<id>.meta.json`) or an embedded `provenance` field.
 * NEVER part of an artifact's content id (A1 section 3.2).
 */
const ProvenanceBody = Type.Object(
  {
    produced_by: Type.Object({
      run_id: Type.String({ minLength: 1 }),
      stage_id: Type.String({ minLength: 1 }),
      kind: Type.String({ minLength: 1 }),
      impl: Type.String({ minLength: 1 }),
      params_sha256: Sha256,
      cache_key: Sha256,
    }),
    inputs: Type.Array(Type.Object({ port: Type.String(), artifact_id: Sha256 }), {
      description: "Edges of the lineage DAG.",
    }),
    pipeline_spec_id: Sha256,
    tool_versions: Type.Object({
      gp_cli: Type.String(),
      git_commit: Type.Optional(Type.String()),
      git_dirty: Type.Optional(Type.Boolean()),
      node: Type.String(),
      wasm_sha256: Type.Optional(Sha256),
      tool_sha256: Type.Optional(
        Sha256,
      ),
      extractor: Type.Optional(Type.Object({ name: Type.String(), version: SemVer, bundle_sha256: Sha256 })),
    }),
    created_at: Iso8601,
    host: Type.Optional(Type.String()),
    duration_ms: NonNegInt,
  },
  { description: "Where an artifact came from. Outside every content id." },
);
export type Provenance = Static<typeof ProvenanceBody>;

/** Body for a `$defs.Provenance` entry. */
export const ProvenanceDef = ProvenanceBody;
/** Reference to `#/$defs/Provenance`: embed the def once per schema, reference it where needed. */
export const Provenance = Type.Unsafe<Provenance>({ $ref: "#/$defs/Provenance" });
