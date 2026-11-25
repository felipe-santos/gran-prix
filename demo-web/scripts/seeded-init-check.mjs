// E0.3 check: Trainer.fromNetworkDefSeeded(json, seed) is reproducible.
// Standalone on purpose (smoke-test.mjs is owned by another lane); the body of
// `checkSeededInit` can be pasted at the end of smoke-test.mjs unchanged.
//
// Usage: node demo-web/scripts/seeded-init-check.mjs [node package dir]
// Package dir: argument, else $GRAN_PRIX_WASM_NODE, else packages/wasm/dist/node.
// Needs: node scripts/build-wasm.mjs --target both \
//          --web-out packages/wasm/dist/web --node-out packages/wasm/dist/node
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(
  process.argv[2] ?? process.env.GRAN_PRIX_WASM_NODE ?? path.join(here, '../../packages/wasm/dist/node'),
);
const { Trainer, LossKind } = createRequire(import.meta.url)(path.join(pkgDir, 'gran_prix_wasm.js'));

function checkSeededInit() {
  const def = JSON.stringify({
    input_dim: 4,
    layers: [
      { type: 'linear', in_features: 4, out_features: 8 },
      { type: 'activation', function: 'tanh' },
      { type: 'linear', in_features: 8, out_features: 1 },
    ],
  });
  const bitsOf = (w) => Array.from(new Uint32Array(new Float32Array(w).buffer)).join(',');

  const a = Trainer.fromNetworkDefSeeded(def, 42).get_weights();
  Math.random(); Math.random(); // the platform RNG must not influence the result
  const b = Trainer.fromNetworkDefSeeded(def, 42).get_weights();
  const c = Trainer.fromNetworkDefSeeded(def, 43).get_weights();
  assert.ok(a.length > 0, 'seeded trainer has weights');
  assert.equal(bitsOf(a), bitsOf(b), 'same seed -> identical weights');
  assert.notEqual(bitsOf(a), bitsOf(c), 'different seed -> different weights');
  // Explicit-loss variant: same contract.
  const d = Trainer.fromNetworkDefWithLossSeeded(def, LossKind.BinaryCrossEntropy, 42).get_weights();
  assert.equal(bitsOf(a), bitsOf(d), 'fromNetworkDefWithLossSeeded matches fromNetworkDefSeeded for the same seed');
  console.log(`seeded init OK (${a.length} params; seed 42 twice identical, seed 43 differs)`);
}

checkSeededInit();
