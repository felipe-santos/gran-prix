import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests that import the extension's own modules run against the contracts' sources (no build of contracts needed
    // for them); the extension BUNDLE is built from the dist of the sibling packages, so `pnpm -r build` comes first.
    alias: [{ find: /^@gran-prix\/contracts$/, replacement: fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url)) }],
  },
  test: {
    include: ["test/**/*.test.mjs"],
    environment: "node",
    // Chromium launches and settle windows (>= 600 ms per page) live in these tests.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
