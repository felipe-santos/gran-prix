# @gran-prix/infer-ts

Exports a trained gran-prix MLP (a `NetworkDef` JSON plus its flat weights)
as a **self-contained TypeScript module** that runs the forward pass with no
dependencies, no WASM and no `eval`. This is the default inference path for
the browser extension content script (see ADR-005): no page-CSP problems with
WASM, and no WASM boundary cost for tiny networks.

Gran-Prix trains; inference is exported. Parity with the WASM `Trainer` is
tested (tolerance 1e-5 on probabilities; observed max difference is about
1e-6, see "Parity" below).

## Usage

```ts
import { generateInferenceModule } from '@gran-prix/infer-ts';

// From the WASM Trainer (or from a ModelPackage: network_def.json + weights.f32le)
const source = generateInferenceModule(
  trainer.networkDefJson(),
  trainer.get_weights(),
  { paramShapes: trainer.paramShapes() }, // optional layout cross-check
);
writeFileSync('model.generated.ts', source);
```

The generated module has no imports and exports:

| export | meaning |
|---|---|
| `predictLogits(input)` | raw network output for one sample (`Float32Array`, `INPUT_DIM` values in) |
| `predictLogitsBatch(inputs, n)` | raw outputs for `n` row-major samples (`n * OUTPUT_DIM` values) |
| `predictProbs(input)` | output head applied, one sample |
| `predictBatch(inputs, n)` | output head applied, `n` samples (same as WASM `predictProbsBatch`) |
| `NETWORK_DEF_DIGEST` | `sha256:` of the canonical JSON (RFC 8785) of the NetworkDef |
| `WEIGHTS_DIGEST` | `sha256:` of the f32 little-endian weight bytes |
| `INPUT_DIM`, `OUTPUT_DIM`, `PARAM_COUNT`, `HEAD` | constants |

Weights are embedded as a base64 f32 little-endian blob. Generation is
deterministic (same inputs, same text; no timestamps).

**Output head** (`opts.head`, default `'auto'`): sigmoid when the network has one
output, row-wise softmax otherwise (what `Trainer.fromNetworkDef` does). Use
`'sigmoid'` for independent binary heads (`fromNetworkDefWithLoss(BCE)` with
several outputs) and `'none'` to leave the logits alone.

**Input checks** (`opts.checkFinite`, default `true`): wrong lengths always throw
`RangeError`; NaN/Infinity inputs throw too, like the WASM `predict*` methods.

`createPredictor(networkDef, weights, opts)` is an interpreter with the same
surface, for tests and tooling (the CLI). It runs the very same kernel source
as the generated code (`src/kernels.ts` is embedded into every module by
`scripts/embed-kernels.mjs`), so the two are bit-identical; a test enforces it.
It needs no `eval` either, but for shipping to a content script prefer the
generated module: it is specialized to the network and carries no generator code.

## Supported layers

| layer | status |
|---|---|
| `linear` | supported (`[in, out]` row-major weight, `[1, out]` bias) |
| `activation`: `relu`, `tanh`, `sigmoid`, `softmax` | supported (also mid-network; softmax is row-wise) |
| `dropout` | supported, identity at inference |
| `batchnorm` | **rejected** (`UnsupportedLayerError`) |
| `rnn`, `gru` | **rejected** (`UnsupportedLayerError`) |

Why `batchnorm` is rejected: gran-prix BatchNorm keeps **no running
statistics**. It normalizes with the statistics of whatever batch it is given
(and a batch of 1 degenerates to `gamma * x + beta`), so the same sample
produces different outputs depending on the rest of the batch, and
`predict` vs `predictBatch` already disagree inside the WASM Trainer. A
stateless exporter cannot reproduce that; support needs running statistics in
the core first. `rnn`/`gru` carry hidden state between calls, which a
stateless `predictLogits(input)` cannot express (v0 limitation).

The error names the layer, e.g.
`unsupported layer for TS export: layers[1] is "batchnorm". BatchNorm has no running statistics ...`.

## Parity

`pnpm test` trains networks in the WASM Trainer (nodejs build from
`packages/wasm/dist/node`, seeded init, a few training steps), exports
`networkDefJson()` + `get_weights()`, generates the module, imports it and
compares against `predict`, `predictProbs`, `predictProbsBatch`:

- 2-8-1 tanh, 56-32-16-8 relu (multi-class), wider and deeper variants,
  linear-only, dropout, leading activation, independent sigmoid heads, and
  every activation (relu, tanh, sigmoid, softmax) in binary and multi-class nets;
- `fixtures/golden.json`: frozen inputs and WASM outputs, checked without needing
  a WASM build (regenerate with `pnpm run golden` after building WASM);
- the generated source type-checks under `strict` + `noUnusedLocals`, has no imports
  and no dynamic code evaluation;
- WASM exports from E1.2: `validateNetworkDef` (never throws, reports errors) and
  `Trainer.paramShapes()` (name, shape, offset, len in `getWeights()` order).

The WASM build is required: `node scripts/build-wasm.mjs --target nodejs --node-out packages/wasm/dist/node`
(or `pnpm run build` in `packages/wasm`).

## Scripts

- `pnpm test`: vitest.
- `pnpm run build`: re-embeds the kernels and compiles `src` to `dist`.
- `pnpm run embed`: regenerate `src/kernelsSource.ts` after editing `src/kernels.ts`.
- `pnpm run golden`: rewrite `fixtures/golden.json` from the current WASM build.
- `pnpm run typecheck`.
