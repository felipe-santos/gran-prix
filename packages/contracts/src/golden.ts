import { Type, type Static } from "@sinclair/typebox";
import { Sha256, contractObject, defineContract } from "./base.js";

/**
 * golden.json: reference input/output pairs of a ModelPackage. Every runtime
 * (TS, WASM, Rust) must reproduce `expected` within `tolerance` (parity tests).
 * Bound to the weights it was produced from via `weights_sha256`.
 */
export const GoldenContract = defineContract(
  "golden",
  "gran-prix.golden",
  "1.0.0",
  contractObject(
    "golden",
    "gran-prix.golden",
    {
      weights_sha256: Sha256,
      tolerance: Type.Object({
        abs: Type.Number({ minimum: 0 }),
        rel: Type.Optional(Type.Number({ minimum: 0 })),
      }),
      cases: Type.Array(
        Type.Object({
          name: Type.Optional(Type.String()),
          input: Type.Array(Type.Number(), { description: "Feature vector as the extractor emits it (BEFORE fitted normalization)." }),
          raw: Type.Array(Type.Number(), { description: "Network output (logits), before calibration/activation." }),
          score: Type.Array(Type.Number(), { description: "Final model output: after calibration and activation." }),
        }),
        { minItems: 1 },
      ),
    },
    "Golden vectors for cross-runtime parity of a ModelPackage.",
  ),
);
export const GoldenSchema = GoldenContract.schema;
export type Golden = Static<typeof GoldenSchema>;
