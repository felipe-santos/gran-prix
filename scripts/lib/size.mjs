// Shared helpers for measuring WASM artifacts. Node built-ins only.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

/** Raw and gzip (level 9) size in bytes of a file. */
export function measure(file) {
  const buf = readFileSync(file);
  const gz = gzipSync(buf, { level: 9, memLevel: 9 });
  return { raw: buf.length, gzip: gz.length };
}

export const fmt = (n) => n.toLocaleString('en-US').padStart(9) + ' B';
