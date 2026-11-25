import { Type, type Static } from "@sinclair/typebox";
import { PosInt, Sha256, Uint32, Unit01, contractObject, defineContract } from "./base.js";
import { NetworkDefBody } from "./network-def.js";
import { LabelSource } from "./node-labels.js";

/**
 * TrainConfig (generic). Only what a runtime really supports; lints for
 * Dropout / BatchNorm / RNN in the WASM trainer are semantic checks in
 * `validateTrainConfig`, not shape.
 */

const NetworkSpec = Type.Union([
  Type.Object({ kind: Type.Literal("def"), def: NetworkDefBody }),
  Type.Object({
    kind: Type.Literal("mlp"),
    hidden: Type.Array(PosInt),
    activation: Type.Union([Type.Literal("relu"), Type.Literal("tanh"), Type.Literal("sigmoid")]),
    input_dim: Type.Union([Type.Literal("auto"), PosInt], { description: '"auto" = feature schema dim.' }),
  }),
]);

export const TrainConfigContract = defineContract(
  "train-config",
  "gran-prix.train-config",
  "1.0.0",
  contractObject(
    "train-config",
    "gran-prix.train-config",
    {
      train_config_id: Type.Optional(Sha256),
      seed: Uint32,
      network: NetworkSpec,
      loss: Type.Union([Type.Literal("bce_logits"), Type.Literal("ce_logits")]),
      optimizer: Type.Object({ kind: Type.Literal("adam"), lr: Type.Number({ exclusiveMinimum: 0 }) }),
      lr_schedule: Type.Optional(
        Type.Union([
          Type.Object({ kind: Type.Literal("constant") }),
          Type.Object({ kind: Type.Literal("step"), every: PosInt, gamma: Type.Number({ exclusiveMinimum: 0, maximum: 1 }) }),
          Type.Object({ kind: Type.Literal("cosine"), min_lr: Type.Number({ minimum: 0 }) }),
        ]),
      ),
      epochs: PosInt,
      batch_size: PosInt,
      data: Type.Object({
        min_confidence: Unit01,
        allowed_sources: Type.Array(LabelSource),
        class_balance: Type.Object({
          strategy: Type.Union([
            Type.Literal("none"),
            Type.Literal("oversample_pos"),
            Type.Literal("undersample_neg"),
            Type.Literal("pos_weight"),
          ]),
          target_pos_rate: Type.Optional(Unit01),
          pos_weight: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
        }),
      }),
      normalization: Type.Object({
        kind: Type.Union([Type.Literal("none"), Type.Literal("zscore")]),
        fit_on: Type.Literal("train"),
      }),
      early_stopping: Type.Optional(
        Type.Object({
          metric: Type.Union([Type.Literal("val_loss"), Type.Literal("val_f1")]),
          patience: PosInt,
          min_delta: Type.Number({ minimum: 0 }),
        }),
      ),
      threshold: Type.Union([
        Type.Object({ strategy: Type.Literal("fixed"), value: Unit01 }),
        Type.Object({ strategy: Type.Literal("max_f1_on_val") }),
      ]),
      init_from: Type.Optional(Type.Object({ model_id: Sha256 })),
      freeze_prefixes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      runtime: Type.Object({
        engine: Type.Union([Type.Literal("wasm-node"), Type.Literal("gp-train")]),
      }),
    },
    "Training recipe: seed (mandatory), network, loss, optimizer, data policy, normalization, early stopping, threshold.",
  ),
);
export const TrainConfigSchema = TrainConfigContract.schema;
export type TrainConfig = Static<typeof TrainConfigSchema>;
