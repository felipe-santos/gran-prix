/**
 * Node-level checks of the E1.2 WASM exports against the nodejs build:
 * `validateNetworkDef` (R2), `Trainer.paramShapes` (R3), plus the E0 contract
 * that a failed training call leaves the Trainer deterministic (the in-loop
 * eval-mode restore itself is covered by native Rust tests).
 */
import { describe, expect, it } from 'vitest';
import { Lcg, loadWasm, mlp } from './helpers.js';

const wasm = loadWasm();
const json = (o: unknown): string => JSON.stringify(o);

describe('validateNetworkDef (R2)', () => {
  it('accepts a valid definition and reports dims and parameter count', () => {
    const r = wasm.validateNetworkDef(json(mlp(56, [32, 16], 8, 'relu')));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.inputDim).toBe(56);
    expect(r.outputDim).toBe(8);
    expect(r.paramCount).toBe(56 * 32 + 32 + 32 * 16 + 16 + 16 * 8 + 8);
  });

  it('counts parameters of layers the TS exporter rejects (batchnorm, rnn, gru)', () => {
    const bn = wasm.validateNetworkDef(
      json({
        input_dim: 4,
        layers: [
          { type: 'linear', in_features: 4, out_features: 6 },
          { type: 'batchnorm', num_features: 6 },
          { type: 'linear', in_features: 6, out_features: 1 },
        ],
      }),
    );
    expect(bn.ok).toBe(true);
    expect(bn.paramCount).toBe(4 * 6 + 6 + 2 * 6 + 6 + 1);
    const rnn = wasm.validateNetworkDef(
      json({ input_dim: 3, layers: [{ type: 'rnn', input_size: 3, hidden_size: 5 }] }),
    );
    expect(rnn.ok).toBe(true);
    expect(rnn.paramCount).toBeGreaterThan(0);
  });

  const invalid: Array<[string, string]> = [
    ['empty string', ''],
    ['not json', '{ nope'],
    ['json null', 'null'],
    ['json array', '[]'],
    ['json number', '5'],
    ['missing layers', json({ input_dim: 2 })],
    ['empty layers', json({ input_dim: 2, layers: [] })],
    ['zero input_dim', json({ input_dim: 0, layers: [{ type: 'linear', in_features: 0, out_features: 1 }] })],
    [
      'dimension mismatch',
      json({
        input_dim: 2,
        layers: [
          { type: 'linear', in_features: 2, out_features: 8 },
          { type: 'linear', in_features: 5, out_features: 1 },
        ],
      }),
    ],
    [
      'unknown layer type',
      json({ input_dim: 2, layers: [{ type: 'conv9000' }] }),
    ],
    [
      'bad dropout rate',
      json({
        input_dim: 2,
        layers: [
          { type: 'linear', in_features: 2, out_features: 2 },
          { type: 'dropout', rate: 1.5 },
        ],
      }),
    ],
    [
      'batchnorm width mismatch',
      json({
        input_dim: 2,
        layers: [
          { type: 'linear', in_features: 2, out_features: 4 },
          { type: 'batchnorm', num_features: 3 },
        ],
      }),
    ],
  ];

  for (const [label, input] of invalid) {
    it(`reports (does not throw) for: ${label}`, () => {
      let r: ReturnType<typeof wasm.validateNetworkDef> | undefined;
      expect(() => {
        r = wasm.validateNetworkDef(input);
      }).not.toThrow();
      expect(r?.ok).toBe(false);
      expect(r?.errors.length).toBeGreaterThan(0);
      expect(typeof r?.errors[0]).toBe('string');
      expect(r?.paramCount).toBeUndefined();
    });
  }

  it('agrees with Trainer construction (valid <=> constructible)', () => {
    for (const [, input] of invalid) {
      expect(() => wasm.Trainer.fromNetworkDefSeeded(input, 1)).toThrow();
    }
    const good = json(mlp(3, [4], 2, 'tanh'));
    expect(wasm.validateNetworkDef(good).ok).toBe(true);
    wasm.Trainer.fromNetworkDefSeeded(good, 1).free();
  });
});

describe('Trainer.paramShapes (R3)', () => {
  it('lists name/shape/offset/len in getWeights order', () => {
    const t = wasm.Trainer.fromNetworkDefSeeded(json(mlp(5, [7], 3, 'relu', { dropout: 0.1 })), 9);
    const shapes = t.paramShapes();
    expect(shapes).toEqual([
      { name: 'layers[0].weight', shape: [5, 7], offset: 0, len: 35 },
      { name: 'layers[0].bias', shape: [1, 7], offset: 35, len: 7 },
      { name: 'layers[3].weight', shape: [7, 3], offset: 42, len: 21 },
      { name: 'layers[3].bias', shape: [1, 3], offset: 63, len: 3 },
    ]);
    expect(t.get_weights().length).toBe(66);
    expect(t.paramCount()).toBe(shapes.length);
    t.free();
  });

  it('slicing by offset/len reproduces the layout rules (weight row-major [in,out], zero bias at init)', () => {
    const t = wasm.Trainer.fromNetworkDefSeeded(json(mlp(2, [3], 1, 'tanh')), 5);
    const w = t.get_weights();
    for (const p of t.paramShapes()) {
      expect(p.shape.reduce((a, b) => a * b, 1)).toBe(p.len);
      const slice = w.slice(p.offset, p.offset + p.len);
      if (p.name.endsWith('.bias')) expect(Array.from(slice).every((v) => v === 0)).toBe(true);
      else expect(Array.from(slice).some((v) => v !== 0)).toBe(true);
    }
    t.free();
  });

  it('describes layers the TS exporter rejects too (batchnorm gamma/beta)', () => {
    const t = wasm.Trainer.fromNetworkDefSeeded(
      json({
        input_dim: 2,
        layers: [
          { type: 'linear', in_features: 2, out_features: 4 },
          { type: 'batchnorm', num_features: 4 },
          { type: 'linear', in_features: 4, out_features: 1 },
        ],
      }),
      1,
    );
    expect(t.paramShapes().map((p) => p.name)).toEqual([
      'layers[0].weight',
      'layers[0].bias',
      'layers[1].gamma',
      'layers[1].beta',
      'layers[2].weight',
      'layers[2].bias',
    ]);
    t.free();
  });
});

describe('eval mode after a failed training call (E0 contract, Node level)', () => {
  it('predictions stay deterministic and unchanged after trainBatch errors', () => {
    const t = wasm.Trainer.fromNetworkDefSeeded(json(mlp(4, [8], 1, 'relu', { dropout: 0.5 })), 3);
    const probe = new Lcg(5).floats(4);
    const before = t.predict(probe);
    expect(t.predict(probe)).toBe(before);

    // Argument validation errors (wrong input length) happen before the loop.
    expect(() => t.train_batch(new Float32Array(7), new Float32Array(2), 0.1)).toThrow();
    expect(() => t.trainBatchMultiClass(new Float32Array(8), new Uint32Array([0, 0]), 0.1)).toThrow();
    expect(t.predict(probe)).toBe(before);
    expect(t.predict(probe)).toBe(before);
    t.free();
  });
});
