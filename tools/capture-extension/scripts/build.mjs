// Builds the unpacked extension into dist/ (load THIS folder in chrome://extensions). No remote code: every byte is
// produced here from the repository's own built packages.
//
//   dist/manifest.json        the shipped manifest (activeTab + scripting + downloads, no host_permissions)
//   dist/background.js        service worker: orchestration + the collector's snapshot builder, bundled by esbuild
//   dist/popup.html/.js       the popup
//   dist/gp-features.iife.js  the probe, the SAME artifact the collect stage injects (packages/features/dist)
//   dist/flatten-page.js      `window.__gpFlat = <FLATTEN_SOURCE>`: the collect stage's flatten expression
//
// With `--test-build`, also writes dist-test/: identical files, but the manifest additionally holds host_permissions for
// 127.0.0.1/localhost, because browser automation cannot perform the toolbar click that grants `activeTab`. Never load it.
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..", "..");
const FEATURES_BUNDLE = join(repo, "packages", "features", "dist", "gp-features.iife.js");
const FLATTEN_JS = join(repo, "tools", "cli", "dist", "stages", "collect", "flatten.js");

function requireBuilt() {
  for (const p of [FEATURES_BUNDLE, FLATTEN_JS, join(repo, "packages", "contracts", "dist", "identity", "hash.js"), join(repo, "packages", "labels", "dist", "set-readers.js")]) {
    if (!existsSync(p)) throw new Error(`${p} is missing: run \`pnpm -r build\` (the extension reuses the built packages) and retry`);
  }
}

/** esbuild plugin: the Node-only imports of the reused collector code are replaced by the shims in src/shims. */
const nodeShims = {
  name: "gp-node-shims",
  setup(b) {
    const to = { "node:crypto": "crypto.js", "node:zlib": "zlib.js", "@gran-prix/contracts": "contracts-lite.js" };
    b.onResolve({ filter: /^(node:crypto|node:zlib|@gran-prix\/contracts)$/ }, (a) => ({ path: join(root, "src", "shims", to[a.path]) }));
  },
};

export async function buildExtension({ outDir = join(root, "dist"), hostPermissions = [] } = {}) {
  requireBuilt();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  await build({
    entryPoints: [join(root, "src", "background.js"), join(root, "src", "popup.js")],
    outdir: outDir,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome110",
    legalComments: "none",
    logLevel: "warning",
    plugins: [nodeShims],
    inject: [join(root, "src", "shims", "buffer.js")],
  });

  copyFileSync(FEATURES_BUNDLE, join(outDir, "gp-features.iife.js"));
  copyFileSync(join(root, "src", "popup.html"), join(outDir, "popup.html"));
  const { FLATTEN_SOURCE } = await import(pathToFileURL(FLATTEN_JS).href);
  writeFileSync(join(outDir, "flatten-page.js"), `window.__gpFlat = ${FLATTEN_SOURCE};\n`);

  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  if (hostPermissions.length > 0) manifest.host_permissions = hostPermissions;
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return outDir;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dist = await buildExtension();
  console.log(`extension: ${dist}`);
  if (process.argv.includes("--test-build")) {
    const t = await buildExtension({ outDir: join(root, "dist-test"), hostPermissions: ["http://127.0.0.1/*", "http://localhost/*"] });
    console.log(`test build (never load it): ${t}`);
  }
}
