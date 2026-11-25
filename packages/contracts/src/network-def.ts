import { Type, type Static } from "@sinclair/typebox";
import { PosInt, defineContract } from "./base.js";

/**
 * NetworkDef JSON: the Rust core's own serialization (`src/network_def.rs`,
 * `LayerDef` + `NetworkDef`). Mirrored here so TrainConfig, ModelPackage and
 * the pipeline can validate it without a WASM call.
 *
 * Deliberately STRICT (`additionalProperties: false`): serde ignores unknown
 * fields silently, so a typo'd or newer field must be caught on this side.
 * Dimension chaining, dropout range etc. stay the job of the Rust
 * `NetworkDef::validate` (the loader calls `Trainer.fromNetworkDef`).
 */

export const ActivationFunction = Type.Union([
  Type.Literal("relu"),
  Type.Literal("sigmoid"),
  Type.Literal("tanh"),
  Type.Literal("softmax"),
]);
export type ActivationFunction = Static<typeof ActivationFunction>;

const strict = { additionalProperties: false } as const;

export const LayerDef = Type.Union([
  Type.Object({ type: Type.Literal("linear"), in_features: PosInt, out_features: PosInt }, strict),
  Type.Object({ type: Type.Literal("activation"), function: ActivationFunction }, strict),
  Type.Object({ type: Type.Literal("rnn"), input_size: PosInt, hidden_size: PosInt }, strict),
  Type.Object({ type: Type.Literal("gru"), input_size: PosInt, hidden_size: PosInt }, strict),
  Type.Object({ type: Type.Literal("dropout"), rate: Type.Number({ minimum: 0, exclusiveMaximum: 1 }) }, strict),
  Type.Object({ type: Type.Literal("batchnorm"), num_features: PosInt }, strict),
]);
export type LayerDef = Static<typeof LayerDef>;

export const LAYER_TYPES = ["linear", "activation", "dropout", "batchnorm", "rnn", "gru"] as const;
export type LayerType = (typeof LAYER_TYPES)[number];

/** NetworkDef without `$id`: the form that is embedded in other schemas (TrainConfig). */
export const NetworkDefBody = Type.Object(
  {
    input_dim: PosInt,
    layers: Type.Array(LayerDef, { minItems: 1 }),
  },
  strict,
);
export type NetworkDef = Static<typeof NetworkDefBody>;

/** Standalone contract (own `$id`), emitted as `network-def.schema.json`. */
export const NetworkDefContract = defineContract(
  "network-def",
  "gran-prix.network-def",
  "1.0.0",
  Type.Object(NetworkDefBody.properties, {
    ...strict,
    $id: "urn:gran-prix:schema:network-def",
    title: "network-def",
    description: "Exact JSON of the Rust NetworkDef (no format envelope: it is the core's own format).",
  }),
);
export const NetworkDefSchema = NetworkDefContract.schema;
