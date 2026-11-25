#!/usr/bin/env node
/**
 * Fails (exit 1) when a WASM file exceeds the raw or gzip size budget.
 *
 *   node scripts/check-wasm-size.mjs [file.wasm ...] [--max-raw N] [--max-gzip N]
 *
 * Default file: gran-prix-wasm/pkg/gran_prix_wasm_bg.wasm
 * Default budget (provisional decision D8): raw <= 480000 B, gzip -9 <= 200000 B.
 */
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { measure, fmt } from './lib/size.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let maxRaw = 480_000;
let maxGzip = 200_000;
const files = [];

const num = (flag, v) => {
  const n = Number(v);
  if (v === undefined || !Number.isInteger(n) || n < 0) {
    console.error(`${flag} needs a non-negative integer, got "${v}"`);
    process.exit(2);
  }
  return n;
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--max-raw') maxRaw = num(a, argv[++i]);
  else if (a.startsWith('--max-raw=')) maxRaw = num('--max-raw', a.slice(10));
  else if (a === '--max-gzip') maxGzip = num(a, argv[++i]);
  else if (a.startsWith('--max-gzip=')) maxGzip = num('--max-gzip', a.slice(11));
  else if (a.startsWith('-')) { console.error(`unknown argument: ${a}`); process.exit(2); }
  else files.push(resolve(a));
}
if (files.length === 0) files.push(join(ROOT, 'gran-prix-wasm/pkg/gran_prix_wasm_bg.wasm'));

let failed = false;
for (const f of files) {
  if (!existsSync(f)) {
    console.error(`[FAIL] missing file: ${f}`);
    failed = true;
    continue;
  }
  const { raw, gzip } = measure(f);
  const rawOk = raw <= maxRaw;
  const gzOk = gzip <= maxGzip;
  console.log(f);
  console.log(`  raw  ${fmt(raw)}  budget ${fmt(maxRaw)}  [${rawOk ? 'OK' : 'FAIL'}]`);
  console.log(`  gzip ${fmt(gzip)}  budget ${fmt(maxGzip)}  [${gzOk ? 'OK' : 'FAIL'}]`);
  if (!rawOk || !gzOk) failed = true;
}
if (failed) {
  console.error('WASM size budget exceeded or file missing');
  process.exit(1);
}
console.log('WASM size within budget');
