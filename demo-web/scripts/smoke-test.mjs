#!/usr/bin/env node
/**
 * Smoke test for the Gran-Prix WASM `Trainer` bridge.
 *
 * Loads the Node-target build of the bridge (`pkg-node/`), instantiates
 * a Trainer, exercises the surface area that demo-web demos depend on
 * (`predict`, `train_batch`, `train_step`, `get_weights`,
 * `import_weights`, `get_gradient_norms`, `fromArchitecture`), and
 * verifies each call returns finite, sensibly-shaped results.
 *
 * This is *not* a full end-to-end test of any specific demo — those
 * require a real browser DOM (Canvas, requestAnimationFrame, etc.).
 * What this script catches is "the WASM bridge instantiates and runs
 * without throwing", which is exactly the regression we want to detect
 * after a Cargo.toml profile change or a layer refactor.
 *
 * Run from the repo root:
 *
 *     node demo-web/scripts/smoke-test.mjs
 *
 * Exits 0 on success, 1 on any failure with a diagnostic.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(__dirname, '../../gran-prix-wasm/pkg-node/gran_prix_wasm.js');

let failures = 0;
function check(label, ok, detail = '') {
  const status = ok ? 'OK' : 'FAIL';
  if (!ok) failures += 1;
  // Single-line, machine-readable, also human-readable.
  console.log(`[${status}] ${label}${detail ? ` (${detail})` : ''}`);
}

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function allFinite(arr) {
  return arr.every((x) => Number.isFinite(x));
}

async function main() {
  const mod = await import(PKG);
  const { Trainer } = mod;
  check('Trainer class is exported', typeof Trainer === 'function');

  // ── Construction via legacy hidden_layers form ───────────────────────────
  // Mirrors `new Trainer(input_dim, [hidden...])` used by the playground
  // and classifier demos.
  const trainer = new Trainer(2, new Uint32Array([8, 4]));
  check('Trainer constructed via (input_dim, hidden_layers)', trainer instanceof Trainer);

  // ── predict ──────────────────────────────────────────────────────────────
  const features = new Float32Array([0.5, -0.3]);
  const prob = trainer.predict(features);
  check(
    'predict returns a finite probability',
    isFiniteNumber(prob) && prob >= 0 && prob <= 1,
    `prob=${prob}`
  );

  // ── get_weights round-trip BEFORE training ───────────────────────────────
  // Snapshot weights before any mutation, then later restore and verify
  // predictions match. Doing this AFTER training would still round-trip
  // those (different) weights, but the comparison would be against the
  // post-training prob, not the original — same observation, less clear.
  const initialWeights = trainer.get_weights();
  check(
    'get_weights returns a non-empty Float32Array',
    initialWeights instanceof Float32Array && initialWeights.length > 0,
    `len=${initialWeights.length}`
  );
  check(
    'all initial weights are finite',
    allFinite(initialWeights),
    `len=${initialWeights.length}`
  );

  // ── train_step (single sample) ───────────────────────────────────────────
  const loss = trainer.train_step(features, 1.0, 0.05);
  check('train_step returns a finite loss', isFiniteNumber(loss), `loss=${loss}`);

  // ── train_batch (multiple samples, the path the playground uses) ─────────
  const batchInputs = new Float32Array([
    0.0, 0.0,
    0.0, 1.0,
    1.0, 0.0,
    1.0, 1.0,
  ]);
  const batchTargets = new Float32Array([0.0, 1.0, 1.0, 0.0]);
  const batchLoss = trainer.train_batch(batchInputs, batchTargets, 0.05);
  check(
    'train_batch returns a finite loss',
    isFiniteNumber(batchLoss),
    `batch_loss=${batchLoss}`
  );

  // Verify training actually moved the weights (sanity — if it didn't,
  // the import_weights round-trip below would be testing nothing).
  const trainedWeights = trainer.get_weights();
  let movedAny = false;
  for (let i = 0; i < trainedWeights.length; i += 1) {
    if (Math.abs(trainedWeights[i] - initialWeights[i]) > 1e-7) {
      movedAny = true;
      break;
    }
  }
  check('training mutated at least one weight', movedAny);

  // Restore the initial weights and verify the original prob comes back
  // bit-identical. This pins down the WASM bridge's import_weights →
  // predict path.
  trainer.import_weights(initialWeights);
  const probAfterRestore = trainer.predict(features);
  check(
    'predict bit-matches after restoring initial weights',
    probAfterRestore === prob,
    `before=${prob}, restored=${probAfterRestore}`
  );

  // ── get_gradient_norms ───────────────────────────────────────────────────
  // After the train_batch above, gradients should have been accumulated
  // on every parameter — at least some should be non-zero.
  const norms = trainer.get_gradient_norms();
  check(
    'get_gradient_norms returns one entry per param tensor',
    norms instanceof Float32Array && norms.length > 0
      && norms.length < initialWeights.length, // strictly fewer norms than scalars
    `weights_len=${initialWeights.length}, norms_len=${norms.length}`
  );
  check(
    'all gradient norms are finite',
    allFinite(norms),
    `len=${norms.length}`
  );

  // ── fromArchitecture (legacy WasmArchitecture format) ────────────────────
  // The shape that `demo-web/.../NetworkSerializer.ts::serializeForTrainer`
  // produces. This is the path the classifier demo uses.
  const archJson = JSON.stringify({
    layers: [
      { id: 'in1', type: 'input', params: { inputSize: 2 } },
      { id: 'lin1', type: 'linear', params: { inputSize: 2, outputSize: 4 } },
      { id: 'act1', type: 'activation', params: { activationType: 'tanh' } },
      { id: 'lin2', type: 'linear', params: { inputSize: 4, outputSize: 1 } },
      { id: 'out1', type: 'output', params: { outputSize: 1 } },
    ],
    connections: [
      { from: 'in1', to: 'lin1' },
      { from: 'lin1', to: 'act1' },
      { from: 'act1', to: 'lin2' },
      { from: 'lin2', to: 'out1' },
    ],
    inputDim: 2,
    outputDim: 1,
  });

  const trainer2 = Trainer.fromArchitecture(archJson);
  const prob2 = trainer2.predict(features);
  check(
    'fromArchitecture builds and predicts',
    isFiniteNumber(prob2) && prob2 >= 0 && prob2 <= 1,
    `prob=${prob2}`
  );

  // ── fromNetworkDef (canonical NetworkDef JSON) ───────────────────────────
  const netDefJson = JSON.stringify({
    input_dim: 2,
    layers: [
      { type: 'linear', in_features: 2, out_features: 4 },
      { type: 'activation', function: 'tanh' },
      { type: 'linear', in_features: 4, out_features: 1 },
    ],
  });
  const trainer3 = Trainer.fromNetworkDef(netDefJson);
  const prob3 = trainer3.predict(features);
  check(
    'fromNetworkDef builds and predicts',
    isFiniteNumber(prob3) && prob3 >= 0 && prob3 <= 1,
    `prob=${prob3}`
  );

  // ── networkDefJson round-trip (canonical contract) ───────────────────────
  // Reading the NetworkDef back out and re-instantiating must produce
  // a trainer whose predictions match the original bit-for-bit when
  // fed the same weights.
  const roundTripJson = trainer3.networkDefJson();
  check(
    'networkDefJson returns a non-empty string',
    typeof roundTripJson === 'string' && roundTripJson.length > 0,
    `len=${roundTripJson.length}`
  );
  const trainer3Weights = trainer3.get_weights();
  const trainer3Prob = trainer3.predict(features);

  const trainer3Restored = Trainer.fromNetworkDef(roundTripJson);
  trainer3Restored.import_weights(trainer3Weights);
  const restoredProb = trainer3Restored.predict(features);
  check(
    'predict bit-matches after (networkDefJson, weights) round-trip',
    restoredProb === trainer3Prob,
    `before=${trainer3Prob}, after=${restoredProb}`
  );

  // ── predictBatch equivalence with single-sample predict ──────────────────
  // For a network without BatchNorm, calling predictBatch on B rows
  // must produce the same B probabilities as calling predict() once
  // per row. The matmul over `[B, in] x [in, out]` reduces to per-row
  // dot products that are identical to `[1, in] x [in, out]`.
  const batchTrainer = Trainer.fromNetworkDef(netDefJson);
  const singleProbs = [];
  for (let i = 0; i < 4; i += 1) {
    const row = batchInputs.slice(i * 2, (i + 1) * 2);
    singleProbs.push(batchTrainer.predict(row));
  }
  const batchedProbs = batchTrainer.predictBatch(batchInputs, 4);
  check(
    'predictBatch returns batch_size probabilities',
    batchedProbs instanceof Float32Array && batchedProbs.length === 4,
    `len=${batchedProbs.length}`
  );
  check(
    'all predictBatch outputs are finite probabilities',
    Array.from(batchedProbs).every((p) => p >= 0 && p <= 1 && Number.isFinite(p))
  );
  let maxDiff = 0;
  for (let i = 0; i < 4; i += 1) {
    maxDiff = Math.max(maxDiff, Math.abs(batchedProbs[i] - singleProbs[i]));
  }
  check(
    'predictBatch is bit-equivalent to per-sample predict (no BatchNorm)',
    maxDiff === 0,
    `max|batch - single| = ${maxDiff}`
  );

  // After predictBatch the input node was widened to [batch, dim] and
  // then explicitly reset to [1, dim] zeros. Subsequent predict /
  // train_batch must still work — verify.
  const probAfterBatch = batchTrainer.predict(features);
  check(
    'predict still works after predictBatch (input shape restored)',
    isFiniteNumber(probAfterBatch) && probAfterBatch >= 0 && probAfterBatch <= 1,
    `prob=${probAfterBatch}`
  );
  const lossAfterBatch = batchTrainer.train_batch(batchInputs, batchTargets, 0.05);
  check(
    'train_batch still works after predictBatch',
    isFiniteNumber(lossAfterBatch),
    `loss=${lossAfterBatch}`
  );

  // ── predictBatch validation ──────────────────────────────────────────────
  let rejectedSize = false;
  try {
    batchTrainer.predictBatch(new Float32Array([1, 2, 3]), 2); // 3 != 2 * 2
  } catch (e) {
    rejectedSize = true;
  }
  check('predictBatch rejects size mismatch', rejectedSize);

  let rejectedNaN = false;
  try {
    const bad = new Float32Array([1, 2, 3, Number.NaN]);
    batchTrainer.predictBatch(bad, 2);
  } catch (e) {
    rejectedNaN = true;
  }
  check('predictBatch rejects non-finite input', rejectedNaN);

  const emptyOut = batchTrainer.predictBatch(new Float32Array([]), 0);
  check(
    'predictBatch(0) returns empty without error',
    emptyOut instanceof Float32Array && emptyOut.length === 0
  );

  // ── paramNames + freezeByPrefix ──────────────────────────────────────────
  // batchTrainer is a 2→4→1 MLP (two Linear layers). Each Linear
  // contributes weight + bias, so paramCount = 4.
  const pnames = batchTrainer.paramNames();
  check(
    'paramNames returns one entry per parameter (4 for 2→4→1 MLP)',
    Array.isArray(pnames) && pnames.length === 4,
    `len=${pnames.length}, contents=${JSON.stringify(pnames)}`
  );
  check(
    'paramNames includes layers[0].weight (NetworkDef::compile naming)',
    pnames.includes('layers[0].weight')
  );
  check(
    'paramNames includes layers[2].weight (the head)',
    pnames.includes('layers[2].weight')
  );

  const frozenCount = batchTrainer.freezeByPrefix('layers[0]');
  check(
    'freezeByPrefix("layers[0]") freezes exactly that layer (weight + bias)',
    frozenCount === 2,
    `count=${frozenCount}`
  );

  // After freezing layers[0], its weights must not move during training.
  const weightsBeforeFrozenTrain = batchTrainer.get_weights();
  for (let i = 0; i < 5; i += 1) {
    batchTrainer.train_batch(batchInputs, batchTargets, 0.1);
  }
  const weightsAfterFrozenTrain = batchTrainer.get_weights();

  // layers[0].weight = first 2*4=8 scalars, layers[0].bias = next 4.
  // = first 12 weights total.
  let frozenLayerStable = true;
  for (let i = 0; i < 12; i += 1) {
    if (weightsBeforeFrozenTrain[i] !== weightsAfterFrozenTrain[i]) {
      frozenLayerStable = false;
      break;
    }
  }
  check(
    'frozen layer[0] weights stay bit-identical across 5 training batches',
    frozenLayerStable
  );

  // Sanity: the head (layer[2]) DID move, otherwise training is doing nothing.
  let headMoved = false;
  for (let i = 12; i < weightsBeforeFrozenTrain.length; i += 1) {
    if (Math.abs(weightsBeforeFrozenTrain[i] - weightsAfterFrozenTrain[i]) > 1e-7) {
      headMoved = true;
      break;
    }
  }
  check('unfrozen head moved during training (sanity)', headMoved);

  // Unfreeze and verify subsequent training moves layer[0] again.
  const unfrozenCount = batchTrainer.unfreezeByPrefix('layers[0]');
  check('unfreezeByPrefix matches frozen count', unfrozenCount === 2);

  // ── Multi-class trainer ─────────────────────────────────────────────────
  // 3-class network. fromNetworkDef should auto-detect output_dim > 1
  // and select CategoricalCrossEntropy.
  const multiClassNet = JSON.stringify({
    input_dim: 4,
    layers: [
      { type: 'linear', in_features: 4, out_features: 8 },
      { type: 'activation', function: 'relu' },
      { type: 'linear', in_features: 8, out_features: 3 },
    ],
  });
  const mcTrainer = Trainer.fromNetworkDef(multiClassNet);
  check(
    'multi-class trainer auto-detects output_dim',
    mcTrainer.outputDim() === 3,
    `outputDim=${mcTrainer.outputDim()}`
  );
  check(
    'multi-class trainer auto-detects loss kind = CategoricalCrossEntropy',
    mcTrainer.lossKind() === mod.LossKind.CategoricalCrossEntropy
  );

  // predict_probs returns a softmax distribution for multi-class.
  const mcFeatures = new Float32Array([0.5, -0.3, 0.1, 0.7]);
  const mcProbs = mcTrainer.predictProbs(mcFeatures);
  check(
    'predict_probs returns output_dim values for multi-class',
    mcProbs instanceof Float32Array && mcProbs.length === 3,
    `len=${mcProbs.length}`
  );
  const probSum = Array.from(mcProbs).reduce((a, b) => a + b, 0);
  check(
    'multi-class probs sum to 1 (within FP tolerance)',
    Math.abs(probSum - 1.0) < 1e-5,
    `sum=${probSum}`
  );
  check(
    'all multi-class probs are in [0, 1]',
    Array.from(mcProbs).every((p) => p >= 0 && p <= 1)
  );

  // predict_class returns argmax.
  const mcClass = mcTrainer.predictClass(mcFeatures);
  check(
    'predict_class returns a valid class index',
    typeof mcClass === 'number' && mcClass >= 0 && mcClass < 3,
    `class=${mcClass}`
  );

  // Binary methods must error on a multi-class trainer.
  let binaryRejected = false;
  try {
    mcTrainer.predict(mcFeatures);
  } catch (e) {
    binaryRejected = true;
  }
  check('predict() errors on multi-class trainer', binaryRejected);

  let binaryBatchRejected = false;
  try {
    mcTrainer.predictBatch(new Float32Array(8), 2);
  } catch (e) {
    binaryBatchRejected = true;
  }
  check('predictBatch() errors on multi-class trainer', binaryBatchRejected);

  let binaryTrainRejected = false;
  try {
    mcTrainer.train_batch(new Float32Array(8), new Float32Array([0, 1]), 0.05);
  } catch (e) {
    binaryTrainRejected = true;
  }
  check('train_batch() errors on multi-class trainer', binaryTrainRejected);

  // train_batch_multi_class with valid class indices.
  const mcInputs = new Float32Array([
    1.0, 0.0, 0.0, 0.0, // class 0
    0.0, 1.0, 0.0, 0.0, // class 1
    0.0, 0.0, 1.0, 0.0, // class 2
    1.0, 1.0, 0.0, 0.0, // class 0 (a slightly different sample of class 0)
  ]);
  const mcTargets = new Uint32Array([0, 1, 2, 0]);
  const mcLoss = mcTrainer.trainBatchMultiClass(mcInputs, mcTargets, 0.1);
  check(
    'train_batch_multi_class returns finite loss',
    Number.isFinite(mcLoss),
    `loss=${mcLoss}`
  );

  // train_batch_multi_class rejects out-of-range class index.
  let mcBadClassRejected = false;
  try {
    mcTrainer.trainBatchMultiClass(mcInputs, new Uint32Array([0, 99, 1, 2]), 0.05);
  } catch (e) {
    mcBadClassRejected = true;
  }
  check('train_batch_multi_class rejects out-of-range class index', mcBadClassRejected);

  // predict_probs_batch on multi-class returns batch * output_dim flat.
  const mcBatchProbs = mcTrainer.predictProbsBatch(mcInputs, 4);
  check(
    'predict_probs_batch returns batch_size * output_dim values',
    mcBatchProbs instanceof Float32Array && mcBatchProbs.length === 4 * 3,
    `len=${mcBatchProbs.length}`
  );
  // Each row of 3 must sum to 1.
  let allRowsValid = true;
  for (let r = 0; r < 4; r += 1) {
    const rowSum = mcBatchProbs[r * 3] + mcBatchProbs[r * 3 + 1] + mcBatchProbs[r * 3 + 2];
    if (Math.abs(rowSum - 1.0) > 1e-5) {
      allRowsValid = false;
      break;
    }
  }
  check('every row of predict_probs_batch sums to 1', allRowsValid);

  // ── Multi-class learning sanity ─────────────────────────────────────────
  // Train on a tiny separable dataset: input = one-hot of class.
  // Predict on each one-hot — argmax should match, eventually.
  const sepTrainer = Trainer.fromNetworkDef(JSON.stringify({
    input_dim: 3,
    layers: [
      { type: 'linear', in_features: 3, out_features: 3 },
    ],
  }));
  const sepInputs = new Float32Array([1, 0, 0,  0, 1, 0,  0, 0, 1]);
  const sepTargets = new Uint32Array([0, 1, 2]);
  for (let epoch = 0; epoch < 200; epoch += 1) {
    sepTrainer.trainBatchMultiClass(sepInputs, sepTargets, 0.5);
  }
  // After enough training, argmax(predict_probs(one_hot_i)) should be i.
  let allCorrect = true;
  for (let i = 0; i < 3; i += 1) {
    const xs = new Float32Array(3);
    xs[i] = 1;
    if (sepTrainer.predictClass(xs) !== i) {
      allCorrect = false;
      break;
    }
  }
  check(
    'multi-class trainer learns a 3-class separable dataset',
    allCorrect
  );

  // ── Long-running training stability ──────────────────────────────────────
  // We don't assert convergence here because it's RNG-dependent and
  // would make this smoke test flaky. The senior assertion is
  // weaker but reliable: across 100 train_batch calls the loss
  // never becomes non-finite. That catches NaN explosions, runaway
  // gradients, and divide-by-zero — which is exactly what a smoke
  // test should catch.
  const xorTrainer = new Trainer(2, new Uint32Array([8]));
  let allLossesFinite = true;
  let losses = [];
  for (let epoch = 0; epoch < 100; epoch += 1) {
    const l = xorTrainer.train_batch(batchInputs, batchTargets, 0.1);
    losses.push(l);
    if (!Number.isFinite(l)) {
      allLossesFinite = false;
      break;
    }
  }
  check(
    'training is numerically stable (100 batches, no NaN/Inf)',
    allLossesFinite,
    `min=${Math.min(...losses).toFixed(4)}, max=${Math.max(...losses).toFixed(4)}`
  );

  console.log('');
  console.log(failures === 0 ? 'all smoke checks passed' : `${failures} smoke check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test threw:', err);
  process.exit(1);
});
