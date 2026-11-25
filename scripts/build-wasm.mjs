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
 *   web     -> gran-prix-wasm/pkg        (ES module + initSync; demo-web uses packages/wasm/dist/web)
 *   nodejs  -> gran-prix-wasm/pkg-node   (CommonJS; Node scripts use packages/wasm/dist/node)
 *   both    -> both of the above; with --out-dir <dir> the web build goes to
 *              <dir> and the nodejs build to <dir>-node.
 *
 * Explicit per-target directories take precedence over --out-dir:
 *   --web-out <dir>   directory of the web build
 *   --node-out <dir>  directory of the nodejs build
 * The published layout used by demo-web and CI is
 *   node scripts/build-wasm.mjs --target both \
 *        --web-out packages/wasm/dist/web --node-out packages/wasm/dist/node
 * (`pnpm build:wasm` does exactly that).
 *
 * Reproducibility across machines: panic locations embed source paths. The build maps
 * the machine-specific ones to fixed names with `--remap-path-prefix` (appended to any
 * RUSTFLAGS / CARGO_ENCODED_RUSTFLAGS already set, never replacing them):
 *   $CARGO_HOME/registry/src   -> /cargo/registry/src
 *   $CARGO_HOME/git/checkouts  -> /cargo/git/checkouts
 *   <rustc sysroot>/lib/rustlib/src/rust -> /rustc/<commit-hash>   (what `std` already uses)
 *   <rustc sysroot>            -> /rustc-sysroot
 *   <repo root>                -> .
 * so the .wasm does not depend on the user's home directory or checkout location.
 * Note: setting RUSTFLAGS through the environment overrides `build.rustflags` of any
 * .cargo/config.toml (cargo uses only one source); this repo defines none.
 * Requires `wasm-pack` on PATH and the wasm32-unknown-unknown Rust target.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
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

/** Both the path as given and its symlink-resolved form (rustc may print either). */
function pathForms(p) {
  const forms = new Set([resolve(p)]);
  try { forms.add(realpathSync(p)); } catch { /* path does not exist on this machine */ }
  return [...forms];
}

/** `--remap-path-prefix` flags that make the build independent of this machine's layout. */
function remapFlags() {
  const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
  const rustc = spawnSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' });
  const sysroot = rustc.status === 0 ? rustc.stdout.trim() : '';
  const info = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  const commit = (info.stdout ?? '').match(/^commit-hash: ([0-9a-f]{40})$/m)?.[1];

  // Generic prefixes first: when several mappings match, rustc uses the last one.
  const rules = [];
  const add = (from, to) => { for (const f of pathForms(from)) rules.push([f, to]); };
  add(ROOT, '.');
  if (sysroot) {
    add(sysroot, '/rustc-sysroot');
    if (commit) add(join(sysroot, 'lib', 'rustlib', 'src', 'rust'), `/rustc/${commit}`);
  } else {
    console.warn('warning: `rustc --print sysroot` failed; toolchain paths are not remapped');
  }
  add(join(cargoHome, 'git', 'checkouts'), '/cargo/git/checkouts');
  add(join(cargoHome, 'registry', 'src'), '/cargo/registry/src');

  return rules
    // `FROM=TO` is split on the last '=', so a prefix containing '=' cannot be expressed.
    .filter(([from]) => !from.includes('='))
    .map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
}

/** User flags (CARGO_ENCODED_RUSTFLAGS wins over RUSTFLAGS, as in cargo) plus ours, encoded. */
function rustflagsEnv() {
  const user = process.env.CARGO_ENCODED_RUSTFLAGS !== undefined
    ? process.env.CARGO_ENCODED_RUSTFLAGS.split('\x1f').filter(Boolean)
    : (process.env.RUSTFLAGS ?? '').split(/\s+/).filter(Boolean);
  return { CARGO_ENCODED_RUSTFLAGS: [...user, ...remapFlags()].join('\x1f') };
}

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
    { cwd: CRATE, stdio: 'inherit', env: { ...process.env, ...SIZE_PROFILE_ENV, ...RUSTFLAGS_ENV } },
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
const RUSTFLAGS_ENV = rustflagsEnv();
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
