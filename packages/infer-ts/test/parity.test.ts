import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson, createPredictor, generateInferenceModule, paramLayout, parseNetworkDef } from '../src/index.js';
import {
  Lcg,
  bitsOf,
  loadWasm,
  materialize,
  maxAbsDiff,
  mlp,
  trainSome,
  type Layer,
  type WasmTrainer,
} from './helpers.js';

const wasm = loadWasm();
const TOL = 1e-5;

interface Case {
  name: string;
  def: { input_dim: number; layers: Layer[] };
  /** `binary` = Trainer auto head; `independent` = BCE heads with output_dim > 1. */
  kind: 'auto' | 'independent';
  steps: number;
}

const ACTS = ['relu', 'tanh', 'sigmoid', 'softmax'] as const;

const CASES: Case[] = [
  { name: 'binary-2-8-1-tanh', def: mlp(2, [8], 1, 'tanh'), kind: 'auto', steps: 40 },
  { name: 'multiclass-56-32-16-8-relu', def: mlp(56, [32, 16], 8, 'relu'), kind: 'auto', steps: 40 },
  { name: 'wide-10-64-64-1-relu', def: mlp(10, [64, 64], 1, 'relu'), kind: 'auto', steps: 30 },
  { name: 'deep-16-32-16-32-24-4-tanh', def: mlp(16, [32, 16, 32, 24], 4, 'tanh'), kind: 'auto', steps: 30 },
  { name: 'linear-only-6-3', def: mlp(6, [], 3, 'relu'), kind: 'auto', steps: 20 },
  { name: 'dropout-8-16-16-2', def: mlp(8, [16, 16], 2, 'relu', { dropout: 0.3 }), kind: 'auto', steps: 30 },
  { name: 'leading-activation-5-7-1', def: mlp(5, [7], 1, 'tanh', { leadingActivation: true }), kind: 'auto', steps: 20 },
  { name: 'independent-heads-12-16-3', def: mlp(12, [16], 3, 'relu'), kind: 'independent', steps: 0 },
  ...ACTS.map(
    (a): Case => ({ name: `activation-${a}-9-12-12-5`, def: mlp(9, [12, 12], 5, a), kind: 'auto', steps: 25 }),
  ),
  ...ACTS.map(
    (a): Case => ({ name: `activation-${a}-binary-6-10-1`, def: mlp(6, [10], 1, a), kind: 'auto', steps: 25 }),
  ),
];

const observed: Array<{ name: string; probs: number; batch: number; single: number }> = [];

function build(c: Case): WasmTrainer {
  const json = JSON.stringify(c.def);
  if (c.kind === 'independent') {
    return wasm.Trainer.fromNetworkDefWithLossSeeded(json, wasm.LossKind.BinaryCrossEntropy, 11);
  }
  return wasm.Trainer.fromNetworkDefSeeded(json, 42);
}

function trainAny(c: Case, t: WasmTrainer): void {
  if (c.kind === 'independent') {
    // Independent sigmoid heads have no multi-class train method; perturb the
    // weights deterministically instead so they are non-trivial.
    const w = t.get_weights();
    const rng = new Lcg(99);
    for (let i = 0; i < w.length; i++) w[i] += rng.next() * 0.3;
    (t as unknown as { import_weights(x: Float32Array): void }).import_weights(w);
    return;
  }
  const outDim = c.def.layers.filter((l): l is Extract<Layer, { type: 'linear' }> => l.type === 'linear').at(-1)!
    .out_features;
  trainSome(t, c.def.input_dim, outDim, c.steps);
}

describe('generated TS module vs WASM Trainer', () => {
  for (const c of CASES) {
    it(`${c.name}: probabilities within ${TOL} of WASM`, async () => {
      const trainer = build(c);
      const initial = trainer.get_weights().slice();
      trainAny(c, trainer);
      const weights = trainer.get_weights();
      expect(maxAbsDiff(initial, weights)).toBeGreaterThan(1e-3); // non-trivial weights

      const json = trainer.networkDefJson();
      const shapes = trainer.paramShapes();
      const head = c.kind === 'independent' ? 'sigmoid' : 'auto';
      const code = generateInferenceModule(json, weights, { head, paramShapes: shapes });
      const mod = await materialize(c.name, code);
      const oracle = createPredictor(json, weights, { head });

      const dim = c.def.input_dim;
      const outDim = mod.OUTPUT_DIM;
      const n = 64;
      const rng = new Lcg(1234);
      // Mix of small and saturating inputs.
      const inputs = rng.floats(n * dim, 3);

      const wasmBatch = trainer.predictProbsBatch(inputs, n);
      const tsBatch = mod.predictBatch(inputs, n);
      const dBatch = maxAbsDiff(wasmBatch, tsBatch);

      let dProbs = 0;
      let dSingle = 0;
      for (let i = 0; i < n; i++) {
        const row = inputs.slice(i * dim, (i + 1) * dim);
        const probs = mod.predictProbs(row);
        expect(probs.length).toBe(outDim);
        dProbs = Math.max(dProbs, maxAbsDiff(probs, trainer.predictProbs(row)));
        if (outDim === 1) dSingle = Math.max(dSingle, Math.abs(probs[0] - trainer.predict(row)));
      }
      observed.push({ name: c.name, probs: dProbs, batch: dBatch, single: dSingle });

      expect(dBatch).toBeLessThanOrEqual(TOL);
      expect(dProbs).toBeLessThanOrEqual(TOL);
      expect(dSingle).toBeLessThanOrEqual(TOL);

      // Batch and per-sample paths of the generated module agree exactly.
      for (let i = 0; i < n; i++) {
        const row = inputs.slice(i * dim, (i + 1) * dim);
        expect(bitsOf(mod.predictProbs(row))).toEqual(bitsOf(tsBatch.slice(i * outDim, (i + 1) * outDim)));
      }

      // Interpreter and generated code run the same kernels: bit-identical.
      expect(bitsOf(oracle.predictBatch(inputs, n))).toEqual(bitsOf(tsBatch));
      expect(bitsOf(oracle.predictLogitsBatch(inputs, n))).toEqual(bitsOf(mod.predictLogitsBatch(inputs, n)));

      // Constants: digest of the canonical NetworkDef, computed independently with node:crypto.
      const expectedDigest =
        'sha256:' + createHash('sha256').update(canonicalJson(parseNetworkDef(json))).digest('hex');
      expect(mod.NETWORK_DEF_DIGEST).toBe(expectedDigest);
      const wbytes = Buffer.alloc(weights.length * 4);
      weights.forEach((w, i) => wbytes.writeFloatLE(w, i * 4));
      expect(mod.WEIGHTS_DIGEST).toBe('sha256:' + createHash('sha256').update(wbytes).digest('hex'));
      expect(mod.PARAM_COUNT).toBe(weights.length);
      expect(mod.INPUT_DIM).toBe(dim);

      // The layout derived from the NetworkDef equals WASM paramShapes().
      expect(paramLayout(parseNetworkDef(json))).toEqual(shapes);

      // The generated module is deterministic text.
      expect(generateInferenceModule(json, weights, { head, paramShapes: shapes })).toBe(code);
      trainer.free();
    });
  }

  afterAll(() => {
    const worst = Math.max(...observed.flatMap((o) => [o.probs, o.batch, o.single]));
    console.log(
      `[parity] ${observed.length} architectures; max |TS - WASM| = ${worst.toExponential(3)} (tolerance ${TOL})\n` +
        observed
          .map(
            (o) =>
              `  ${o.name.padEnd(36)} single=${o.probs.toExponential(2)} batch=${o.batch.toExponential(2)} predict=${o.single.toExponential(2)}`,
          )
          .join('\n'),
    );
  });
});

describe('generated module runtime contract', () => {
  it('rejects bad input lengths and non-finite values, and never mutates the input', async () => {
    const t = wasm.Trainer.fromNetworkDefSeeded(JSON.stringify(mlp(4, [6], 1, 'relu', { leadingActivation: true })), 3);
    trainSome(t, 4, 1, 5);
    const mod = await materialize(
      'contract',
      generateInferenceModule(t.networkDefJson(), t.get_weights()),
    );
    expect(() => mod.predictLogits(new Float32Array(3))).toThrow(RangeError);
    expect(() => mod.predictBatch(new Float32Array(8), 3)).toThrow(RangeError);
    expect(() => mod.predictProbs(new Float32Array([0, NaN, 0, 0]))).toThrow(/not finite/);
    const x = new Float32Array([-1, 2, -3, 4]);
    const copy = x.slice();
    mod.predictLogits(x);
    mod.predictProbs(x);
    expect(Array.from(x)).toEqual(Array.from(copy)); // leading ReLU worked on a copy
    expect(mod.predictBatch(new Float32Array(0), 0).length).toBe(0);
    t.free();
  });

  it('checkFinite:false skips the finite check', async () => {
    const t = wasm.Trainer.fromNetworkDefSeeded(JSON.stringify(mlp(2, [3], 1, 'tanh')), 3);
    const mod = await materialize(
      'nofinite',
      generateInferenceModule(t.networkDefJson(), t.get_weights(), { checkFinite: false }),
    );
    expect(() => mod.predictLogits(new Float32Array([NaN, 0]))).not.toThrow();
    t.free();
  });
});
