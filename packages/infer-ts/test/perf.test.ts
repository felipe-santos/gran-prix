/**
 * Performance note (not a gate): generated TS vs WASM Trainer on the DOM-like
 * architecture 56 -> 32 -> 16 -> 8, in Node. Numbers are logged; the only
 * assertions are sanity checks (outputs agree), so slow CI machines cannot
 * make this flaky.
 */
import { describe, expect, it } from 'vitest';
import { generateInferenceModule } from '../src/index.js';
import { Lcg, loadWasm, materialize, maxAbsDiff, mlp, trainSome } from './helpers.js';

const wasm = loadWasm();

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function bench(fn: () => void, warmup: number, iters: number): number {
  for (let i = 0; i < warmup; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return median(times);
}

describe('perf: 56-32-16-8, 500 inputs', () => {
  it('predictBatch (generated TS) vs predictProbsBatch (WASM)', async () => {
    const dim = 56;
    const n = 500;
    const trainer = wasm.Trainer.fromNetworkDefSeeded(JSON.stringify(mlp(dim, [32, 16], 8, 'relu')), 42);
    trainSome(trainer, dim, 8, 40);
    const mod = await materialize('perf', generateInferenceModule(trainer.networkDefJson(), trainer.get_weights()));
    const inputs = new Lcg(77).floats(n * dim);

    expect(maxAbsDiff(mod.predictBatch(inputs, n), trainer.predictProbsBatch(inputs, n))).toBeLessThan(1e-5);

    const tsBatch = bench(() => mod.predictBatch(inputs, n), 30, 300);
    const wasmBatch = bench(() => trainer.predictProbsBatch(inputs, n), 30, 300);

    // Per-sample path: what a content script does when scoring nodes one by one.
    const rows: Float32Array[] = [];
    for (let i = 0; i < n; i++) rows.push(inputs.slice(i * dim, (i + 1) * dim));
    const tsSingle = bench(() => rows.forEach((r) => mod.predictProbs(r)), 5, 40);
    const wasmSingle = bench(() => rows.forEach((r) => trainer.predictProbs(r)), 5, 40);

    const f = (x: number): string => x.toFixed(3).padStart(8) + ' ms';
    console.log(
      `[perf] node ${process.version}, 56-32-16-8, ${n} inputs, median of repeated runs\n` +
        `  one batch call   generated TS predictBatch : ${f(tsBatch)}\n` +
        `  one batch call   WASM predictProbsBatch    : ${f(wasmBatch)}   (TS/WASM = ${(tsBatch / wasmBatch).toFixed(2)}x)\n` +
        `  ${n} single calls  generated TS predictProbs  : ${f(tsSingle)}\n` +
        `  ${n} single calls  WASM predictProbs          : ${f(wasmSingle)}   (WASM/TS = ${(wasmSingle / tsSingle).toFixed(1)}x)`,
    );
    expect(tsBatch).toBeGreaterThan(0);
    trainer.free();
  });
});
