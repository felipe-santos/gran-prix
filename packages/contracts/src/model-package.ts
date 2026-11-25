import { Type, type Static } from "@sinclair/typebox";
import { NonNegInt, PosInt, SemVer, Sha256, Unit01, contractObject, defineContract } from "./base.js";
import { LAYER_TYPES } from "./network-def.js";
import { Provenance, ProvenanceDef } from "./provenance.js";

/**
 * ModelPackage v1 (ADR-003): a DIRECTORY holding
 *   network_def.json   exact output of NetworkDef::to_json / Trainer.networkDefJson()
 *   weights.f32le      little-endian float32, ParamStore::export_flat order
 *   model.json         THIS contract
 *   golden.json        see golden.ts
 * The NetworkDef stays pure (Rust core unchanged). `model_id` covers behavior
 * only (see `modelId()`); `metrics` and `provenance` are outside the hash.
 */

const LayerTypeName = Type.Union(LAYER_TYPES.map((t) => Type.Literal(t)));

const FileEntry = Type.Object({
  path: Type.String({ minLength: 1, description: "Relative to the package directory." }),
  bytes: NonNegInt,
});

export const FeatureSpec = Type.Object({
  schema_id: Sha256,
  name: Type.String({ minLength: 1 }),
  version: SemVer,
  dim: PosInt,
  names: Type.Array(Type.String({ minLength: 1 }), { description: "names[i] === FeatureSchema.features[i].name." }),
  normalization: Type.Union([
    Type.Object({ kind: Type.Literal("none") }),
    Type.Object({
      kind: Type.Literal("zscore"),
      mean: Type.Array(Type.Number()),
      std: Type.Array(Type.Number()),
      eps: Type.Number({ exclusiveMinimum: 0 }),
    }),
  ]),
  ood: Type.Object(
    {
      lo: Type.Array(Type.Number()),
      hi: Type.Array(Type.Number()),
      tolerance: Type.Number({ minimum: 0, description: "Fraction of (hi - lo) allowed beyond the range before the input is flagged OOD." }),
    },
    { description: "Per-feature training range, to flag out-of-distribution inputs." },
  ),
});
export type FeatureSpec = Static<typeof FeatureSpec>;

export const Calibration = Type.Union([
  Type.Object({ kind: Type.Literal("none") }),
  Type.Object({ kind: Type.Literal("platt"), a: Type.Number(), b: Type.Number() }),
  Type.Object({ kind: Type.Literal("temperature"), t: Type.Number({ exclusiveMinimum: 0 }) }),
]);
export type Calibration = Static<typeof Calibration>;

export const OutputSpec = Type.Object({
  activation: Type.Union([Type.Literal("sigmoid"), Type.Literal("softmax"), Type.Literal("identity")], {
    description: "Applied by the runtime to the network output (after calibration of the logit).",
  }),
  labels: Type.Array(Type.String({ minLength: 1 }), { minItems: 2, description: "Class names; for sigmoid, labels[1] is the positive class." }),
  calibration: Calibration,
});
export type OutputSpec = Static<typeof OutputSpec>;

export const Thresholds = Type.Object(
  {
    accept: Unit01,
    escalate: Unit01,
    margin: Type.Number({ minimum: 0, maximum: 1 }),
  },
  {
    description:
      "score >= accept: accept. escalate <= score < accept (or top1-top2 gap < margin): escalate to a stronger judge. score < escalate: reject. Requires escalate <= accept.",
  },
);
export type Thresholds = Static<typeof Thresholds>;

export const ModelPackageContract = defineContract(
  "model-package",
  "gran-prix.model-package",
  "1.1.0",
  contractObject(
    "model-package",
    "gran-prix.model-package",
    {
      model_id: Sha256,
      name: Type.String({ minLength: 1 }),
      description: Type.Optional(Type.String()),
      task: Type.Object({
        name: Type.String({ minLength: 1, description: "Free-form, e.g. dom-content-classifier." }),
        unit: Type.String({ minLength: 1 }),
        stateless: Type.Boolean({ description: "false: recurrent state is out-of-band (KNOWN-GAPS)." }),
      }),
      files: Type.Object({
        network_def: FileEntry,
        weights: Type.Object({ ...FileEntry.properties, dtype: Type.Literal("f32le"), count: NonNegInt }),
        golden: FileEntry,
      }),
      digest: Type.Object(
        {
          algorithm: Type.Literal("sha256"),
          network_def: Sha256,
          weights: Sha256,
          golden: Sha256,
        },
        {
          description:
            "network_def: sha256 of the RFC 8785 canonical JSON of the parsed network_def.json; weights/golden: sha256 of the raw file bytes. golden is verified at load but is not part of model_id.",
        },
      ),
      network: Type.Object({
        input_dim: PosInt,
        output_dim: PosInt,
        param_layout: Type.Array(
          Type.Object({
            name: Type.String({ minLength: 1 }),
            shape: Type.Array(PosInt, { minItems: 1 }),
            offset: NonNegInt,
            length: PosInt,
          }),
          { description: 'Names such as "layers[0].weight"; offset/length in floats; contiguous.' },
        ),
      }),
      feature_spec: FeatureSpec,
      output_spec: OutputSpec,
      thresholds: Thresholds,
      requires: Type.Object({
        runtime: Type.Object({ wasm_abi: Type.String({ minLength: 1 }) }),
        layer_types: Type.Array(LayerTypeName),
        extensions: Type.Array(Type.String(), { description: "Unknown extension => the loader must refuse." }),
      }),
      metrics: Type.Optional(
        Type.Object({ eval_report_id: Sha256, headline: Type.Record(Type.String(), Type.Number()) }),
      ),
      provenance: Provenance,
    },
    "model.json of a ModelPackage v1: feature_spec, output_spec, thresholds, digest, metrics and provenance around a pure NetworkDef.",
    { $defs: { Provenance: ProvenanceDef } },
  ),
);
export const ModelPackageSchema = ModelPackageContract.schema;
export type ModelPackage = Static<typeof ModelPackageSchema>;
