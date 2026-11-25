# @gran-prix/model

Loader of the **ModelPackage v1** directory of ADR-003: `model.json`, `network_def.json`,
`weights.f32le`, `golden.json`. It verifies the package with nine checks, in this order, and
fails at the first one with a typed `ModelPackageError` that names it. It never repairs anything.

```ts
import { loadModelPackage, ModelPackageError } from "@gran-prix/model";

try {
  const model = loadModelPackage("models/dom_v1", { runtime: "ts" }); // or "wasm"
  model.modelId;                       // behavior hash, recomputed
  model.predictProbs(features);        // features = extractor output, BEFORE normalization
  model.predictBatch(rows, n);         // n * inputDim values, row-major -> n * outputDim scores
  model.oodFeatures(features);         // indices outside feature_spec.ood
  model.dispose();                     // frees the WASM trainer
} catch (e) {
  if (e instanceof ModelPackageError) console.error(e.check, e.checkNumber, e.details);
}
```

`predict*` applies `feature_spec.normalization` (z-score: `(x - mean) / (std + eps)`), the network,
then `output_spec` (calibration on the logit, then sigmoid / softmax / identity). The `ts` runtime
is `@gran-prix/infer-ts`; the `wasm` runtime is `Trainer.predictLogitsBatch` (raw logits), so calibration
and the output head are applied exactly as in the `ts` runtime.

## The nine checks

| # | id | what is verified |
|---|---|---|
| 1 | `manifest` | `model.json` is valid JSON and passes `validate("model-package")` (schema, invariants, `model_id` recomputation); no unknown `requires.extensions`; known `requires.runtime.wasm_abi` |
| 2 | `files` | every file in `files.*` exists with exactly the declared `bytes` |
| 3 | `digests` | sha256 of the raw bytes of `weights.f32le` and `golden.json` equal `digest.weights` / `digest.golden` |
| 4 | `network-def-digest` | `digest.network_def` equals `artifactId(JSON.parse(network_def.json))` (RFC 8785; whitespace-proof) |
| 5 | `network-def-valid` | WASM `validateNetworkDef` is ok; layer types used are listed in `requires.layer_types` |
| 6 | `dimensions` | network input dim == `network.input_dim` == `feature_spec.dim`; output dim == `network.output_dim` and consistent with `output_spec` (sigmoid: 1; else `labels.length`) |
| 7 | `weights-layout` | weights hold exactly the network's `weightCount` (floats; `Trainer.weightCount()` and `validateNetworkDef().weightCount`); `network.param_layout` equals `paramShapes()` (names, shapes, offsets, lengths) |
| 8 | `round-trip` | `Trainer.fromNetworkDef` + `import_weights`, then `networkDefJson()` is canonically equal to the file (catches fields a runtime ignores silently) and `get_weights()` is bit-identical |
| 9 | `golden` | `golden.json` is valid, bound to these weights, and reproduces through **both** infer-ts and the WASM Trainer (`raw` and `score` each, the latter through `predictLogitsBatch`) within `golden.tolerance` (override: `opts.tolerance`; fallback 1e-5) |

Notes: since the WASM leg uses raw logits, an `identity` output is checked in both runtimes too. A network
infer-ts refuses (BatchNorm, RNN, GRU) fails check 9, since a package must reproduce through both runtimes.

## Running

The tests need the WASM build (`node scripts/build-wasm.mjs --target both --web-out packages/wasm/dist/web
--node-out packages/wasm/dist/node`); they run against the sources of `contracts` and `infer-ts`.
`GRAN_PRIX_WASM_NODE` may point to another `gran_prix_wasm.js`.

```
pnpm --filter @gran-prix/model test
pnpm --filter @gran-prix/model... build      # contracts, infer-ts, model (typecheck needs the first two built)
```

`wasmSha256()` returns the sha256 of the `.wasm` binary in use (the `wasmSha` of stage cache keys).
