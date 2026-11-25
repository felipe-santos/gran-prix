// Build stamp of the WASM packages (Node built-ins only).
//
// `scripts/build-wasm.mjs` writes a BUILD_INFO.json next to every package it builds:
//   { schema, target, source_hash, rustc, wasm_sha256 }
// `source_hash` is a SHA-256 over the Rust sources the .wasm is made from, so a consumer
// (tools/train/scripts/cross-runtime-check.mjs) can tell that a dist was built from other
// sources than the checkout it runs in, without depending on git or on file timestamps.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const STAMP_FILE = 'BUILD_INFO.json';
export const STAMP_SCHEMA = 1;

/** Everything that changes the bytes of the .wasm (directories are walked recursively). */
const SOURCE_ENTRIES = [
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  'src',
  'gran-prix-wasm/Cargo.toml',
  'gran-prix-wasm/src',
];

function* walk(root, rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  if (!statSync(abs).isDirectory()) { yield rel; return; }
  for (const name of readdirSync(abs).sort()) yield* walk(root, `${rel}/${name}`);
}

/** `sha256:<hex>` over (relative path, content) of every source file, in sorted order. */
export function sourceHash(repoRoot) {
  const h = createHash('sha256');
  let files = 0;
  for (const entry of SOURCE_ENTRIES) {
    for (const rel of walk(repoRoot, entry)) {
      h.update(`${rel}\0`).update(readFileSync(join(repoRoot, rel))).update('\0');
      files++;
    }
  }
  return { hash: `sha256:${h.digest('hex')}`, files };
}

export const fileSha256 = (file) => `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
