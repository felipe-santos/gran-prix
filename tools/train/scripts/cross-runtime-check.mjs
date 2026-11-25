#!/usr/bin/env node
// Cross-runtime check of a ModelPackage written by gp-train (E1.6).
//
// The package must reproduce its golden.json (tolerance golden.tolerance.abs, 1e-5) in:
//   1. the WASM Trainer      (packages/wasm/dist/node, via Trainer.fromNetworkDefSeeded + import_weights)
//   2. @gran-prix/infer-ts   (packages/infer-ts/dist, createPredictor)
// and the identities written by Rust (digests, model_id) must be what the TS contracts compute.
// When packages/contracts/dist exists, model.json and golden.json are also validated with
// the contracts validator (JSON Schema + invariants).
//
// Usage:   node tools/train/scripts/cross-runtime-check.mjs <package-dir>
//          node tools/train/scripts/cross-runtime-check.mjs --preflight   (only check the WASM build)
// Exit:    0 ok, 1 a check failed, 2 usage, 3 the WASM build is stale or incompatible (rebuild it).
// Build:   node scripts/build-wasm.mjs --target both --web-out packages/wasm/dist/web --node-out packages/wasm/dist/node
//          pnpm install && pnpm --filter @gran-prix/infer-ts build && pnpm --filter @gran-prix/contracts build
// Env:     GRAN_PRIX_WASM_NODE (dir of the nodejs wasm build), GRAN_PRIX_INFER_TS (dist/index.js),
//          GRAN_PRIX_CONTRACTS (dist/index.js); GP_TRAIN_REQUIRE_NODE=1 makes a missing
//          contracts build a failure instead of a skipped identity check.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STAMP_FILE, fileSha256, sourceHash } from '../../../scripts/lib/wasm-stamp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const preflightOnly = process.argv[2] === '--preflight';
if (!process.argv[2]) {
  console.error('usage: cross-runtime-check.mjs <package-dir> | --preflight');
  process.exit(2);
}
const pkgDir = preflightOnly ? '' : path.resolve(process.argv[2]);
const STALE_EXIT = 3;
const REBUILD = 'node scripts/build-wasm.mjs --target both --web-out packages/wasm/dist/web --node-out packages/wasm/dist/node';

const wasmDir = path.resolve(process.env.GRAN_PRIX_WASM_NODE ?? path.join(root, 'packages/wasm/dist/node'));
const inferEntry = path.resolve(process.env.GRAN_PRIX_INFER_TS ?? path.join(root, 'packages/infer-ts/dist/index.js'));
const contractsEntry = path.resolve(process.env.GRAN_PRIX_CONTRACTS ?? path.join(root, 'packages/contracts/dist/index.js'));

// ---- 0. Is the WASM build the one this checkout needs? ----------------------------------
// A dist built before an API change fails deep inside the run with "x is not a function".
// Detect it first, by build stamp and by the Trainer API this script uses, and say how to fix it.
const REQUIRED_TRAINER_API = [
  'fromNetworkDefSeeded', 'import_weights', 'get_weights', 'networkDefJson', 'paramShapes',
  'paramTensorCount', 'weightCount', 'predictBatch', 'predictProbsBatch', 'predictLogitsBatch', 'free',
];

function wasmBuildProblems() {
  const problems = [];
  const entry = path.join(wasmDir, 'gran_prix_wasm.js');
  if (!existsSync(entry)) return [`${entry} does not exist`];
  const stampFile = path.join(wasmDir, STAMP_FILE);
  if (!existsSync(stampFile)) {
    problems.push(`${STAMP_FILE} is missing in ${wasmDir}: built by an older build-wasm.mjs, so its sources are unknown`);
  } else {
    const stamp = JSON.parse(readFileSync(stampFile, 'utf8'));
    const now = sourceHash(root).hash;
    if (stamp.source_hash !== now) {
      problems.push(`built from other Rust sources (stamp ${String(stamp.source_hash).slice(0, 19)}..., checkout ${now.slice(0, 19)}...)`);
    }
    const wasm = path.join(wasmDir, 'gran_prix_wasm_bg.wasm');
    if (existsSync(wasm) && fileSha256(wasm) !== stamp.wasm_sha256) problems.push('gran_prix_wasm_bg.wasm does not match its BUILD_INFO.json');
  }
  let Trainer;
  try {
    ({ Trainer } = createRequire(import.meta.url)(entry));
  } catch (e) {
    return [...problems, `the module does not load: ${e.message}`];
  }
  const missing = REQUIRED_TRAINER_API.filter((m) => typeof Trainer?.prototype?.[m] !== 'function' && typeof Trainer?.[m] !== 'function');
  if (missing.length > 0) problems.push(`the Trainer API lacks: ${missing.join(', ')}`);
  return problems;
}

const problems = wasmBuildProblems();
if (problems.length > 0) {
  console.error(`STALE OR INCOMPATIBLE WASM BUILD in ${wasmDir}:\n${problems.map((p) => `  - ${p}`).join('\n')}\nRebuild it: ${REBUILD}`);
  process.exit(STALE_EXIT);
}
if (preflightOnly) {
  console.log(`ok   WASM build in ${wasmDir} matches the sources and exposes the Trainer API`);
  process.exit(0);
}

const readText = (f) => readFileSync(path.join(pkgDir, f), 'utf8');
const modelText = readText('model.json');
const model = JSON.parse(modelText);
const netText = readText('network_def.json');
const goldenBytes = readFileSync(path.join(pkgDir, 'golden.json'));
const golden = JSON.parse(goldenBytes.toString('utf8'));
const weightBytes = readFileSync(path.join(pkgDir, 'weights.f32le'));
assert.equal(weightBytes.length % 4, 0, 'weights.f32le is not a multiple of 4 bytes');
const weights = new Float32Array(weightBytes.length / 4);
const view = new DataView(weightBytes.buffer, weightBytes.byteOffset, weightBytes.byteLength);
for (let i = 0; i < weights.length; i++) weights[i] = view.getFloat32(i * 4, true);

const tol = golden.tolerance.abs;
const n = golden.cases.length;
const dim = model.feature_spec.dim;
let failures = 0;
const report = (name, diff, extra = '') => {
  const ok = diff <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(44)} max|diff| = ${diff.toExponential(3)} (tol ${tol})${extra}`);
};
const maxDiff = (got, want) => {
  assert.equal(got.length, want.length, 'length mismatch');
  let m = 0;
  for (let i = 0; i < want.length; i++) m = Math.max(m, Math.abs(got[i] - want[i]));
  return m;
};

// ---- Identities: what Rust wrote must be what the TS contracts compute -------------------
if (existsSync(contractsEntry)) {
  const C = await import(pathToFileURL(contractsEntry).href);
  for (const [contract, doc] of [['model-package', model], ['golden', golden]]) {
    const r = C.validate(contract, doc);
    assert.ok(r.ok, `${contract} fails the contracts validator: ${JSON.stringify(r.issues ?? r)}`);
    console.log(`ok   contracts.validate("${contract}") (JSON Schema + invariants)`);
  }
  assert.equal(C.modelId(model), model.model_id, 'model_id');
  assert.equal(C.artifactId(JSON.parse(netText)), model.digest.network_def, 'digest.network_def');
  assert.equal(C.sha256Of(new Uint8Array(weightBytes)), model.digest.weights, 'digest.weights');
  assert.equal(C.sha256Of(new Uint8Array(goldenBytes)), model.digest.golden, 'digest.golden');
  console.log('ok   model_id and the three digests recomputed by @gran-prix/contracts match Rust');
} else {
  assert.ok(!process.env.GP_TRAIN_REQUIRE_NODE, `GP_TRAIN_REQUIRE_NODE is set but ${contractsEntry} is not built (pnpm --filter @gran-prix/contracts build)`);
  console.log(`skip contracts identity checks (build ${contractsEntry})`);
}
assert.equal(golden.weights_sha256, model.digest.weights, 'golden.weights_sha256 is bound to the weights');

// ---- Inputs as a consumer prepares them: z-score in doubles, stored as float32 -----------
const z = model.feature_spec.normalization;
const normalized = new Float32Array(n * dim);
golden.cases.forEach((c, i) => {
  assert.equal(c.input.length, dim);
  for (let j = 0; j < dim; j++) {
    normalized[i * dim + j] = z.kind === 'zscore' ? (c.input[j] - z.mean[j]) / (z.std[j] + z.eps) : c.input[j];
  }
});
const wantRaw = golden.cases.flatMap((c) => c.raw);
const wantScore = golden.cases.flatMap((c) => c.score);

// ---- 1. WASM Trainer --------------------------------------------------------------------
{
  const { Trainer } = createRequire(import.meta.url)(path.join(wasmDir, 'gran_prix_wasm.js'));
  const t = Trainer.fromNetworkDefSeeded(netText, 0);
  t.import_weights(weights);
  // The round trip of the NetworkDef through the core must keep its identity.
  const C = existsSync(contractsEntry) ? await import(pathToFileURL(contractsEntry).href) : null;
  if (C) assert.equal(C.artifactId(JSON.parse(t.networkDefJson())), model.digest.network_def, 'networkDefJson() round trip');
  assert.equal(t.paramTensorCount(), model.network.param_layout.length, 'paramTensorCount (tensors)');
  assert.deepEqual(Array.from(t.get_weights()), Array.from(weights), 'weights survive import -> export bit for bit');
  const shapes = t.paramShapes();
  model.network.param_layout.forEach((p, i) => {
    assert.equal(shapes[i].name, p.name, `param name ${i}`);
    assert.equal(shapes[i].offset, p.offset, `param offset ${i}`);
    assert.equal(shapes[i].len ?? shapes[i].length, p.length, `param length ${i}`);
  });
  const prob = t.predictBatch(normalized, n);
  report('WASM Trainer.predictBatch vs golden.score', maxDiff(prob, wantScore));
  // The WASM Trainer exposes probabilities, not logits: the logit comparison happens in
  // infer-ts below (inverting a float32 sigmoid is ill-conditioned away from 0.5).
  report('WASM Trainer.predictProbsBatch vs golden.score', maxDiff(t.predictProbsBatch(normalized, n), wantScore));
  t.free();
}

// ---- 2. @gran-prix/infer-ts -------------------------------------------------------------
{
  const { createPredictor } = await import(pathToFileURL(inferEntry).href);
  const p = createPredictor(netText, weights, { head: 'sigmoid' });
  assert.equal(p.networkDefDigest, model.digest.network_def, 'infer-ts networkDefDigest');
  assert.equal(p.weightsDigest, model.digest.weights, 'infer-ts weightsDigest');
  report('infer-ts predictLogitsBatch vs golden.raw', maxDiff(p.predictLogitsBatch(normalized, n), wantRaw));
  report('infer-ts predictBatch vs golden.score', maxDiff(p.predictBatch(normalized, n), wantScore));
  const gen = p.predictBatch(normalized.slice(0, dim), 1);
  assert.ok(Math.abs(gen[0] - wantScore[0]) <= tol, 'single-sample path');
}

console.log(`${n} golden cases, dim ${dim}, ${failures === 0 ? 'ALL WITHIN TOLERANCE' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
