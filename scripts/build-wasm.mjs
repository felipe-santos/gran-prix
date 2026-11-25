#!/usr/bin/env node
/**
 * Reproducible, size-optimized build of the gran-prix-wasm bridge.
 *
 *   node scripts/build-wasm.mjs [--target web|nodejs|both] [--out-dir <dir>]
 *                               [--web-out <dir>] [--node-out <dir>]
 *
 * The size profile is applied through CARGO_PROFILE_RELEASE_* environment
 * variables instead of `[profile.release]` in gran-prix-wasm/Cargo.toml:
 * profiles of member crates are ignored once the repo becomes a Cargo
 * workspace, while env vars keep working. `wasm-opt -Oz` is configured in
 * `[package.metadata.wasm-pack.profile.release]` of gran-prix-wasm/Cargo.toml.
 *
 * Targets and output directories (relative paths resolve against the repo root):
 *   web     -> gran-prix-wasm/pkg        (ES module + initSync, used by demo-web)
 *   nodejs  -> gran-prix-wasm/pkg-node   (CommonJS, used by the smoke test)
 *   both    -> both of the above; with --out-dir <dir> the web build goes to
 *              <dir> and the nodejs build to <dir>-node.
 *
 * Explicit per-target directories take precedence over --out-dir:
 *   --web-out <dir>   directory of the web build
 *   --node-out <dir>  directory of the nodejs build
 * The published layout used by demo-web and CI is
 *   node scripts/build-wasm.mjs --target both \
 *        --web-out packages/wasm/dist/web --node-out packages/wasm/dist/node
 * (`npm run build` in packages/wasm does exactly that).
 * Requires `wasm-pack` on PATH and the wasm32-unknown-unknown Rust target.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure, fmt } from './lib/size.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CRATE = join(ROOT, 'gran-prix-wasm');

/** Size profile (roadmap E0.6). */
const SIZE_PROFILE_ENV = {
  CARGO_PROFILE_RELEASE_OPT_LEVEL: 'z',
  CARGO_PROFILE_RELEASE_LTO: 'true',
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1',
  CARGO_PROFILE_RELEASE_PANIC: 'abort',
  CARGO_PROFILE_RELEASE_DEBUG: 'false',
};

function usage(code) {
  console.error(
    'usage: node scripts/build-wasm.mjs [--target web|nodejs|both] [--out-dir <dir>]\n' +
    '                                   [--web-out <dir>] [--node-out <dir>]',
  );
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { target: 'web', outDir: null, webOut: null, nodeOut: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (i + 1 < argv.length ? argv[++i] : usage(2));
    if (a === '--target') opts.target = val();
    else if (a.startsWith('--target=')) opts.target = a.slice(9);
    else if (a === '--out-dir') opts.outDir = val();
    else if (a.startsWith('--out-dir=')) opts.outDir = a.slice(10);
    else if (a === '--web-out') opts.webOut = val();
    else if (a.startsWith('--web-out=')) opts.webOut = a.slice(10);
    else if (a === '--node-out') opts.nodeOut = val();
    else if (a.startsWith('--node-out=')) opts.nodeOut = a.slice(11);
    else if (a === '-h' || a === '--help') usage(0);
    else { console.error(`unknown argument: ${a}`); usage(2); }
  }
  if (opts.target === 'node') opts.target = 'nodejs';
  if (!['web', 'nodejs', 'both'].includes(opts.target)) {
    console.error(`invalid --target: ${opts.target}`);
    usage(2);
  }
  return opts;
}

function build(target, outDir) {
  console.log(`\n==> wasm-pack build --release --target ${target} --out-dir ${outDir}`);
  const res = spawnSync(
    'wasm-pack',
    ['build', '--release', '--target', target, '--out-dir', outDir],
    { cwd: CRATE, stdio: 'inherit', env: { ...process.env, ...SIZE_PROFILE_ENV } },
  );
  if (res.error) {
    console.error(`failed to run wasm-pack: ${res.error.message} (is it installed and on PATH?)`);
    process.exit(1);
  }
  if (res.status !== 0) process.exit(res.status ?? 1);
  const wasm = join(outDir, 'gran_prix_wasm_bg.wasm');
  if (!existsSync(wasm)) {
    console.error(`build finished but ${wasm} is missing`);
    process.exit(1);
  }
  return wasm;
}

const opts = parseArgs(process.argv.slice(2));
const abs = (p) => (p ? resolve(ROOT, p) : null);
const base = abs(opts.outDir);
const webDir = abs(opts.webOut) ?? base ?? join(CRATE, 'pkg');
// A lone nodejs target uses --out-dir as is; with `both` it gets the `-node` suffix.
const nodeDir =
  abs(opts.nodeOut) ??
  (base ? (opts.target === 'both' ? `${base}-node` : base) : join(CRATE, 'pkg-node'));
const jobs = [];
if (opts.target === 'web' || opts.target === 'both') jobs.push(['web', webDir]);
if (opts.target === 'nodejs' || opts.target === 'both') jobs.push(['nodejs', nodeDir]);

const results = jobs.map(([target, dir]) => ({ target, dir, wasm: build(target, dir) }));

console.log('\nWASM size (raw / gzip -9):');
for (const r of results) {
  const m = measure(r.wasm);
  console.log(`  ${r.target.padEnd(7)} ${fmt(m.raw)} / ${fmt(m.gzip)}  ${r.wasm}`);
}
