import { Type, type Static } from "@sinclair/typebox";
import { JsonObject, Sha256, contractObject, defineContract } from "./base.js";
import { ArtifactTypeSchema, StageKind } from "./stage-kind-spec.js";

/**
 * PipelineSpec: declarative DAG that the CLI executes and the editor edits.
 * `layout` is editor-only and excluded from the spec id and from cache keys.
 * `${vars.x}` substitution happens BEFORE hashing; `params` here may still
 * contain the placeholders.
 */

export const Ref = Type.Union([
  Type.Object({ stage: Type.String({ minLength: 1 }), output: Type.String({ minLength: 1 }) }),
  Type.Object({ external: Type.String({ minLength: 1 }) }),
]);
export type Ref = Static<typeof Ref>;

export const StageInstance = Type.Object({
  id: Type.String({ pattern: "^[a-z][a-z0-9_]*$", description: "Unique in the spec." }),
  kind: StageKind,
  impl: Type.String({ minLength: 1, description: "Exact impl version; part of the cache key." }),
  params: JsonObject,
  inputs: Type.Record(Type.String(), Type.Union([Ref, Type.Array(Ref)]), { description: "port name -> origin(s)." }),
  cache: Type.Optional(Type.Union([Type.Literal("use"), Type.Literal("refresh"), Type.Literal("off")])),
  gate: Type.Optional(Type.Boolean({ description: "true: a failed stage or failed gate aborts the run." })),
});
export type StageInstance = Static<typeof StageInstance>;

export const PipelineSpecContract = defineContract(
  "pipeline-spec",
  "gran-prix.pipeline-spec",
  "1.0.0",
  contractObject(
    "pipeline-spec",
    "gran-prix.pipeline-spec",
    {
      name: Type.String({ minLength: 1 }),
      description: Type.Optional(Type.String()),
      vars: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
      externals: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Object({ type: ArtifactTypeSchema, path: Type.Optional(Type.String()), id: Type.Optional(Sha256) }),
          { description: "Input files / ids supplied from outside the pipeline." },
        ),
      ),
      stages: Type.Array(StageInstance, { minItems: 1 }),
      layout: Type.Optional(
        Type.Record(Type.String(), Type.Object({ x: Type.Number(), y: Type.Number() }), {
          description: "Editor positions only. Excluded from the spec id.",
        }),
      ),
    },
    "Pipeline instance: stages, typed refs between them, external inputs, variables.",
  ),
);
export const PipelineSpecSchema = PipelineSpecContract.schema;
export type PipelineSpec = Static<typeof PipelineSpecSchema>;
