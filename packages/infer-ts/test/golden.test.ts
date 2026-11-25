/**
 * Golden fixture: networks trained in the WASM Trainer, with inputs and the
 * probabilities WASM produced for them. Testing against the frozen file keeps
 * the TS runtime honest without needing a WASM build, and (re-run with
 * UPDATE_GOLDEN=1 against a fresh build) it pins the Rust -> TS contract.
 *
 * Format `gran-prix-infer-golden/1`:
 *   { format, tolerance, cases: [{ name, head, networkDef, weightsB64,
 *     inputDim, outputDim, n, inputs: number[] (n * inputDim, row-major),
 *     expected: number[] (n * outputDim, row-major WASM predictProbsBatch) }] }
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPredictor, generateInferenceModule } from '../src/index.js';
import { Lcg, PKG_ROOT, loadWasm, materialize, maxAbsDiff, mlp, trainSome } from './helpers.js';

const FIXTURE = join(PKG_ROOT, 'fixtures', 'golden.json');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

interface GoldenCase {
  name: string;
  head: 'auto' | 'sigmoid' | 'softmax' | 'none';
  networkDef: unknown;
  weightsB64: string;
  inputDim: number;
  outputDim: number;
  n: number;
  inputs: number[];
  expected: number[];
}

interface Golden {
  format: 'gran-prix-infer-golden/1';
  tolerance: number;
  cases: GoldenCase[];
}

const SPECS = [
  { name: 'binary-2-8-1-tanh', def: mlp(2, [8], 1, 'tanh'), seed: 1, steps: 40 },
  { name: 'multiclass-56-32-16-8-relu', def: mlp(56, [32, 16], 8, 'relu'), seed: 2, steps: 40 },
  { name: 'dropout-softmax-hidden-6-10-3', def: mlp(6, [10], 3, 'softmax', { dropout: 0.2 }), seed: 3, steps: 25 },
];

function regenerate(): Golden {
  const wasm = loadWasm();
  const cases = SPECS.map((s): GoldenCase => {
    const t = wasm.Trainer.fromNetworkDefSeeded(JSON.stringify(s.def), s.seed);
    const outDim = s.def.layers.filter((l) => l.type === 'linear').at(-1) as { out_features: number };
    trainSome(t, s.def.input_dim, outDim.out_features, s.steps, s.seed);
    const n = 16;
    const inputs = new Lcg(100 + s.seed).floats(n * s.def.input_dim, 2);
    const expected = t.predictProbsBatch(inputs, n);
    const weights = t.get_weights();
    const c: GoldenCase = {
      name: s.name,
      head: 'auto',
      networkDef: JSON.parse(t.networkDefJson()) as unknown,
      weightsB64: Buffer.from(weights.buffer, weights.byteOffset, weights.byteLength).toString('base64'),
      inputDim: s.def.input_dim,
      outputDim: outDim.out_features,
      n,
      inputs: Array.from(inputs),
      expected: Array.from(expected),
    };
    t.free();
    return c;
  });
  return { format: 'gran-prix-infer-golden/1', tolerance: 1e-5, cases };
}

if (UPDATE) {
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, JSON.stringify(regenerate()) + '\n');
}

describe('golden.json (frozen WASM outputs)', () => {
  it('fixture exists (regenerate with `pnpm run golden` against a WASM build)', () => {
    expect(existsSync(FIXTURE)).toBe(true);
  });

  const golden: Golden = existsSync(FIXTURE)
    ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Golden)
    : { format: 'gran-prix-infer-golden/1', tolerance: 1e-5, cases: [] };

  for (const c of golden.cases) {
    it(`${c.name}: generated module and interpreter match the frozen outputs`, async () => {
      expect(golden.format).toBe('gran-prix-infer-golden/1');
      // `.slice()` so the Float32Array owns its buffer; the Buffer pool is shared and unaligned.
      const raw = Buffer.from(c.weightsB64, 'base64');
      const weights = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      const inputs = Float32Array.from(c.inputs);

      const mod = await materialize(`golden-${c.name}`, generateInferenceModule(c.networkDef, weights, { head: c.head }));
      expect(mod.INPUT_DIM).toBe(c.inputDim);
      expect(mod.OUTPUT_DIM).toBe(c.outputDim);

      const viaModule = mod.predictBatch(inputs, c.n);
      const viaInterpreter = createPredictor(c.networkDef, weights, { head: c.head }).predictBatch(inputs, c.n);
      expect(maxAbsDiff(viaModule, c.expected)).toBeLessThanOrEqual(golden.tolerance);
      expect(maxAbsDiff(viaInterpreter, c.expected)).toBeLessThanOrEqual(golden.tolerance);
      console.log(`[golden] ${c.name}: max |TS - WASM| = ${maxAbsDiff(viaModule, c.expected).toExponential(2)}`);
    });
  }
});
