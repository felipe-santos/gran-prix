import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  UnsupportedLayerError,
  assertLayoutMatches,
  base64Encode,
  canonicalJson,
  createPredictor,
  generateInferenceModule,
  paramLayout,
  parseNetworkDef,
  sha256Hex,
} from '../src/index.js';
import { decodeWeights } from '../src/kernels.js';
import { Lcg, PKG_ROOT, generatedPath, materialize, mlp } from './helpers.js';

const json = (o: unknown): string => JSON.stringify(o);
const zeros = (n: number): Float32Array => new Float32Array(n);

describe('unsupported layers fail loudly', () => {
  const base = (layer: unknown, dim = 4): string =>
    json({
      input_dim: 4,
      layers: [
        { type: 'linear', in_features: 4, out_features: dim },
        layer,
        { type: 'linear', in_features: dim, out_features: 1 },
      ],
    });

  it('batchnorm: explains the batch-dependence and recommends rejecting', () => {
    const def = base({ type: 'batchnorm', num_features: 4 });
    expect(() => generateInferenceModule(def, zeros(1))).toThrow(UnsupportedLayerError);
    expect(() => generateInferenceModule(def, zeros(1))).toThrow(/unsupported layer for TS export: layers\[1\] is "batchnorm".*batch/s);
  });

  it('rnn and gru: stateful', () => {
    for (const type of ['rnn', 'gru']) {
      const def = json({ input_dim: 3, layers: [{ type, input_size: 3, hidden_size: 4 }] });
      expect(() => generateInferenceModule(def, zeros(1))).toThrow(
        new RegExp(`unsupported layer for TS export: layers\\[0\\] is "${type}".*state`, 's'),
      );
      expect(() => createPredictor(def, zeros(1))).toThrow(UnsupportedLayerError);
    }
  });

  it('unknown layer types and unknown activations', () => {
    expect(() => parseNetworkDef(base({ type: 'conv2d' }))).toThrow(/unknown layer type/);
    expect(() => parseNetworkDef(base({ type: 'activation', function: 'gelu' }))).toThrow(UnsupportedLayerError);
  });
});

describe('malformed input is rejected', () => {
  it('bad JSON, dimension mismatch, bad dropout, empty layers', () => {
    expect(() => parseNetworkDef('{')).toThrow(/invalid JSON/);
    expect(() => parseNetworkDef(json({ input_dim: 2, layers: [] }))).toThrow(/at least one layer/);
    expect(() =>
      parseNetworkDef(
        json({
          input_dim: 2,
          layers: [
            { type: 'linear', in_features: 2, out_features: 3 },
            { type: 'linear', in_features: 4, out_features: 1 },
          ],
        }),
      ),
    ).toThrow(/layer 1 expects input_dim=4, but previous output is 3/);
    expect(() =>
      parseNetworkDef(json({ input_dim: 2, layers: [{ type: 'dropout', rate: 1 }] })),
    ).toThrow(/dropout rate/);
  });

  it('weights of the wrong length or with non-finite values', () => {
    const def = json(mlp(2, [3], 1, 'relu')); // 2*3+3+3*1+1 = 13
    expect(() => generateInferenceModule(def, zeros(12))).toThrow(/weights length 12 != parameter count 13/);
    const bad = zeros(13);
    bad[4] = NaN;
    expect(() => generateInferenceModule(def, bad)).toThrow(/weights\[4\] is not finite/);
  });

  it('a paramShapes cross-check that disagrees with the layout is rejected', () => {
    const def = json(mlp(2, [3], 1, 'relu'));
    const good = paramLayout(parseNetworkDef(def));
    expect(() => generateInferenceModule(def, zeros(13), { paramShapes: good })).not.toThrow();
    const swapped = good.map((p) => (p.name === 'layers[0].weight' ? { ...p, shape: [3, 2] } : p));
    expect(() => generateInferenceModule(def, zeros(13), { paramShapes: swapped })).toThrow(/layout mismatch/);
    expect(() => assertLayoutMatches(good, good.slice(1))).toThrow(/expected 4 parameters, got 3/);
  });
});

describe('weight layout is [in, out] row-major with a [1, out] bias', () => {
  it('hand-computed 2 -> 3 -> 1 network', async () => {
    // W0 [2,3] = [[1,2,3],[4,5,6]], b0 = [.5,-.5,0]; relu; W1 [3,1] = [1,-1,2], b1 = [.25]
    const w = Float32Array.from([1, 2, 3, 4, 5, 6, 0.5, -0.5, 0, 1, -1, 2, 0.25]);
    const def = json(mlp(2, [3], 1, 'relu'));
    const mod = await materialize('handcalc', generateInferenceModule(def, w, { head: 'none' }));
    // x = [1, -1]: h = [1-4+.5, 2-5-.5, 3-6] = [-2.5, -3.5, -3] -> relu -> 0 ; out = .25
    expect(mod.predictLogits(Float32Array.from([1, -1]))[0]).toBeCloseTo(0.25, 6);
    // x = [2, 1]: h = [2+4+.5, 4+5-.5, 6+6] = [6.5, 8.5, 12]; out = 6.5 - 8.5 + 24 + .25 = 22.25
    expect(mod.predictLogits(Float32Array.from([2, 1]))[0]).toBeCloseTo(22.25, 5);
    expect(createPredictor(def, w, { head: 'none' }).predictLogits(Float32Array.from([2, 1]))[0]).toBeCloseTo(22.25, 5);
  });

  it('a negative control: perturbed weights are detected by the comparison used in the parity tests', async () => {
    const rng = new Lcg(8);
    const def = json(mlp(6, [8], 3, 'tanh'));
    const w = rng.floats(6 * 8 + 8 + 8 * 3 + 3);
    const w2 = w.slice();
    w2[5] += 0.05;
    const x = rng.floats(6);
    const a = createPredictor(def, w).predictProbs(x);
    const b = createPredictor(def, w2).predictProbs(x);
    expect(Math.max(...Array.from(a, (v, i) => Math.abs(v - b[i])))).toBeGreaterThan(1e-4);
  });
});

describe('digest and encoding helpers', () => {
  it('sha256 matches node:crypto across padding boundaries', () => {
    for (const len of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
      const data = randomBytes(len);
      expect(sha256Hex(data)).toBe(createHash('sha256').update(data).digest('hex'));
    }
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('base64 round-trips through the embedded decoder', () => {
    for (const count of [0, 1, 2, 3, 5, 100]) {
      const w = new Lcg(count + 1).floats(count);
      const bytes = new Uint8Array(w.buffer);
      const b64 = base64Encode(bytes);
      expect(b64).toBe(Buffer.from(bytes).toString('base64'));
      expect(Array.from(decodeWeights(b64, count))).toEqual(Array.from(w));
    }
    expect(() => decodeWeights('AAAA', 5)).toThrow(/shorter/);
    expect(() => decodeWeights('AA*A', 1)).toThrow(/invalid base64/);
  });

  it('canonical JSON sorts keys and ignores key order and whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 0.5, y: -1 } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":-1,"z":0.5}}',
    );
    const a = generateInferenceModule('{"layers":[{"type":"linear","in_features":1,"out_features":1}],"input_dim":1}', zeros(2));
    const b = generateInferenceModule(
      '{\n "input_dim": 1,\n "layers": [{"out_features": 1, "in_features": 1, "type": "linear"}]\n}',
      zeros(2),
    );
    expect(a).toBe(b);
  });
});

describe('embedded kernels', () => {
  it('src/kernelsSource.ts is in sync with src/kernels.ts', () => {
    const r = spawnSync(process.execPath, ['scripts/embed-kernels.mjs', '--check'], { cwd: PKG_ROOT, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

describe('generated modules type-check under strict + noUnusedLocals', () => {
  it('compiles with tsc for every head and layer mix, with no imports', async () => {
    const variants: Array<[string, string, Float32Array, 'auto' | 'sigmoid' | 'softmax' | 'none']> = [
      ['tc-binary', json(mlp(3, [4], 1, 'relu')), zeros(3 * 4 + 4 + 4 + 1), 'auto'],
      ['tc-softmax', json(mlp(3, [4], 5, 'tanh', { dropout: 0.5 })), zeros(3 * 4 + 4 + 4 * 5 + 5), 'auto'],
      ['tc-none', json(mlp(3, [4], 2, 'sigmoid', { leadingActivation: true })), zeros(3 * 4 + 4 + 4 * 2 + 2), 'none'],
      ['tc-midsoftmax', json(mlp(3, [4], 2, 'softmax')), zeros(3 * 4 + 4 + 4 * 2 + 2), 'sigmoid'],
    ];
    const files: string[] = [];
    for (const [name, def, w, head] of variants) {
      const code = generateInferenceModule(def, w, { head });
      expect(code).not.toMatch(/^\s*import\s/m);
      // Comments aside, the code must not use dynamic code evaluation (page CSP).
      expect(code.replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/\beval\s*\(|new Function/);
      await materialize(name, code);
      files.push(generatedPath(name));
    }
    const tsc = spawnSync(
      process.execPath,
      [
        'node_modules/typescript/bin/tsc',
        '--noEmit',
        '--strict',
        '--noUnusedLocals',
        '--noUnusedParameters',
        '--noImplicitReturns',
        '--target', 'ES2020',
        '--lib', 'ES2020',
        '--module', 'ESNext',
        '--moduleResolution', 'bundler',
        '--skipLibCheck',
        ...files,
      ],
      { cwd: PKG_ROOT, encoding: 'utf8' },
    );
    expect(tsc.stdout + tsc.stderr).toBe('');
    expect(tsc.status).toBe(0);
  });
});
