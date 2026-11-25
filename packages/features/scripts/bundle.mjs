// Builds the in-page IIFE with esbuild. Used by `pnpm build` and by the test global setup.
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const bundlePath = join(pkgRoot, "dist", "gp-features.iife.js");

/** @returns {Promise<string>} the bundle source (not minified: it is small and stays debuggable). */
export async function buildBundle() {
  const r = await build({
    entryPoints: [join(pkgRoot, "src", "browser.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "chrome110",
    legalComments: "none",
    logLevel: "warning",
  });
  const out = r.outputFiles?.[0];
  if (!out) throw new Error("esbuild produced no output");
  return out.text;
}

export async function writeBundle() {
  const src = await buildBundle();
  mkdirSync(dirname(bundlePath), { recursive: true });
  writeFileSync(bundlePath, src);
  return { path: bundlePath, bytes: Buffer.byteLength(src) };
}
