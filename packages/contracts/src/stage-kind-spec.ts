import { Type, type Static } from "@sinclair/typebox";
import { contractObject, defineContract } from "./base.js";

/**
 * StageKindSpec: registry entry of one stage implementation. The visual editor
 * reads it to draw nodes, typed ports and parameter forms; the CLI reads it to
 * validate `params`. Ports reference artifact types, which map to contracts.
 */

/**
 * `demo` (v1.1) is for stages that exist to exercise the runner (fixtures, examples, tests) and must not borrow
 * a real kind. A real kind promises a contract-conforming output; a `demo` stage promises nothing, so a
 * pipeline with a `demo` stage is never a candidate for a gate or a published artifact.
 */
export const STAGE_KINDS = ["collect", "extract", "label", "dataset", "train", "evaluate", "package", "infer", "demo"] as const;
export const StageKind = Type.Union(STAGE_KINDS.map((k) => Type.Literal(k)));
export type StageKind = (typeof STAGE_KINDS)[number];

/**
 * Artifact types that flow on ports, and the contract each one is an instance
 * (or a set of instances) of. `null` = no contract in this package yet.
 */
export const ARTIFACT_CONTRACTS = {
  UrlList: null,
  SnapshotSet: "page-snapshot",
  FeatureSchema: "feature-schema",
  NodeFeaturesSet: "node-features",
  NodeLabelsSet: "node-labels",
  Dataset: "dataset-manifest",
  NetworkDef: "network-def",
  TrainConfig: "train-config",
  ModelPackage: "model-package",
  EvalReport: "eval-report",
  Bundle: null,
  ContentTree: "content-tree",
  LabelAgreement: "label-agreement",
  QaTaskSet: "qa-task-set",
} as const;
export type ArtifactType = keyof typeof ARTIFACT_CONTRACTS;
export const ARTIFACT_TYPES = Object.keys(ARTIFACT_CONTRACTS) as ArtifactType[];
export const ArtifactTypeSchema = Type.Union(ARTIFACT_TYPES.map((t) => Type.Literal(t)));

export const PortSpec = Type.Object({
  name: Type.String({ pattern: "^[a-z][a-z0-9_]*$" }),
  type: ArtifactTypeSchema,
  many: Type.Optional(Type.Boolean({ description: "Port accepts/emits an ordered list of artifacts." })),
  optional: Type.Optional(Type.Boolean()),
});
export type PortSpec = Static<typeof PortSpec>;

export const StageKindSpecContract = defineContract(
  "stage-kind-spec",
  "gran-prix.stage-kind-spec",
  "1.1.0",
  contractObject(
    "stage-kind-spec",
    "gran-prix.stage-kind-spec",
    {
      kind: StageKind,
      impl: Type.String({ minLength: 1, description: 'Exact implementation id with version, e.g. "ts:label.readability@1.0.0".' }),
      inputs: Type.Array(PortSpec),
      outputs: Type.Array(PortSpec),
      params_schema: Type.Object({}, { additionalProperties: true, description: "JSON Schema (draft-07) of `params`." }),
      runtime: Type.Union([
        Type.Literal("node"),
        Type.Literal("node+playwright"),
        Type.Literal("node+wasm"),
        Type.Literal("browser"),
        Type.Literal("rust"),
      ]),
      determinism: Type.Union([
        Type.Literal("pure"),
        Type.Literal("seeded"),
        Type.Literal("cached-external"),
        Type.Literal("external"),
      ]),
      map_over: Type.Optional(Type.Literal("group", { description: "Run once per group (page); cache per item." })),
      gates: Type.Optional(
        Type.Array(
          Type.Object({ id: Type.String({ minLength: 1 }), description: Type.String() }),
          { description: "Gates this stage can evaluate; instances enable them with `gate: true` + params." },
        ),
      ),
    },
    "Registry entry of a stage implementation: typed ports, params JSON Schema, runtime, determinism, gates.",
  ),
);
export const StageKindSpecSchema = StageKindSpecContract.schema;
export type StageKindSpec = Static<typeof StageKindSpecSchema>;
