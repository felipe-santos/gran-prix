#!/usr/bin/env node
/**
 * Bit-for-bit parity check between two nodejs-target builds of gran-prix-wasm
 * (for example a size-optimized build against a build with another profile).
 *
 *   node scripts/check-wasm-parity.mjs <pkg-node-A> <pkg-node-B>
 *
 * Each package runs the same deterministic workload in its own process
 * (weights are imported from a fixed sequence, so no RNG is involved):
 * multi-class forward pass, binary training (loss trace and final weights),
 * multi-class training, batch prediction and the networkDefJson round trip.
 * Every output is reduced to a SHA-256 over its raw float32 bytes; the two
 * reports must be identical. Exits 1 on any difference.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = (f32) => createHash('sha256').update(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)).digest('hex');

function netDef(out) {
  return JSON.stringify({
    input_dim: 56,
    layers: [
      { type: 'linear', in_features: 56, out_features: 32 }, { type: 'activation', function: 'relu' },
      { type: 'linear', in_features: 32, out_features: 16 }, { type: 'activation', function: 'relu' },
      { type: 'linear', in_features: 16, out_features: out },
    ],
  });
}

function fixedWeights(n, step, amp) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = Math.sin(i * step) * amp;
  return w;
}

function probe(dir) {
  const { Trainer } = createRequire(import.meta.url)(resolve(dir, 'gran_prix_wasm.js'));
  const report = {};

  // 8-class forward pass over 5000 nodes x 56 features.
  const multi = Trainer.fromNetworkDef(netDef(8));
  report.paramCount = multi.get_weights().length;
  multi.import_weights(fixedWeights(report.paramCount, 0.37, 0.2));
  const N = 5000;
  const X = new Float32Array(N * 56);
  for (let i = 0; i < X.length; i++) X[i] = (Math.sin(i * 0.013) + 1) / 2;
  report.forwardProbs = sha(multi.predictProbsBatch(X, N));

  // Multi-class training, 50 steps on a deterministic dataset.
  const M = 128;
  const Xm = X.subarray(0, M * 56);
  const cls = new Uint32Array(M).map((_, i) => i % 8);
  const lossM = new Float32Array(50);
  for (let e = 0; e < lossM.length; e++) lossM[e] = multi.trainBatchMultiClass(Xm, cls, 0.05);
  report.multiLossTrace = sha(lossM);
  report.multiWeightsAfter = sha(multi.get_weights());

  // Binary training, 100 steps.
  const bin = Trainer.fromNetworkDef(netDef(1));
  bin.import_weights(fixedWeights(bin.get_weights().length, 0.11, 0.15));
  const B = 256;
  const Xb = new Float32Array(B * 56);
  const Yb = new Float32Array(B);
  for (let r = 0; r < B; r++) {
    const lab = r % 2;
    Yb[r] = lab;
    for (let c = 0; c < 56; c++) Xb[r * 56 + c] = (c < 8 ? lab : 0.5) + 0.05 * Math.sin(r * 7 + c);
  }
  const loss = new Float32Array(100);
  for (let e = 0; e < loss.length; e++) loss[e] = bin.train_batch(Xb, Yb, 0.01);
  report.binLossTrace = sha(loss);
  report.binLossFirstLast = [loss[0], loss[99]];
  const w = bin.get_weights();
  report.binWeightsAfter = sha(w);
  const pb = bin.predictBatch(Xb, B);
  report.binPredictBatch = sha(pb);

  // networkDefJson + weights round trip must reproduce predictions exactly.
  const clone = Trainer.fromNetworkDef(bin.networkDefJson());
  clone.import_weights(w);
  report.roundTripExact = sha(clone.predictBatch(Xb, B)) === report.binPredictBatch;
  return report;
}

const [a, b] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
if (process.argv.includes('--probe')) {
  console.log(JSON.stringify(probe(a)));
  process.exit(0);
}
if (!a || !b) {
  console.error('usage: node scripts/check-wasm-parity.mjs <pkg-node-A> <pkg-node-B>');
  process.exit(2);
}

const self = fileURLToPath(import.meta.url);
function run(dir) {
  const r = spawnSync(process.execPath, [self, '--probe', resolve(dir)], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`probe failed for ${dir}:\n${r.stderr}`);
    process.exit(1);
  }
  return JSON.parse(r.stdout);
}

const ra = run(a);
const rb = run(b);
let bad = 0;
for (const key of Object.keys(ra)) {
  const same = JSON.stringify(ra[key]) === JSON.stringify(rb[key]);
  if (!same) bad++;
  const shown = typeof ra[key] === 'string' ? `${ra[key].slice(0, 16)}...` : JSON.stringify(ra[key]);
  console.log(`[${same ? 'OK' : 'DIFF'}] ${key} ${shown}${same ? '' : `  vs  ${JSON.stringify(rb[key])}`}`);
}
if (!ra.roundTripExact) bad++;
console.log(bad ? `PARITY FAILED (${bad} difference(s))` : 'PARITY OK: outputs are bit-identical');
process.exit(bad ? 1 : 0);
