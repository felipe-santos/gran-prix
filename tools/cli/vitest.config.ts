import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (dir: string, file = "index.ts"): string => fileURLToPath(new URL(`../../${dir}/src/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the sibling sources, so only the WASM build is a prerequisite.
    // Exact patterns: `@gran-prix/labels/testing` must not be caught by the `@gran-prix/labels` alias.
    alias: [
      { find: /^@gran-prix\/contracts$/, replacement: src("packages/contracts") },
      { find: /^@gran-prix\/infer-ts$/, replacement: src("packages/infer-ts") },
      { find: /^@gran-prix\/model$/, replacement: src("packages/model") },
      { find: /^@gran-prix\/features$/, replacement: src("packages/features") },
      { find: /^@gran-prix\/report$/, replacement: src("packages/report") },
      { find: /^@gran-prix\/labels$/, replacement: src("packages/labels") },
      { find: /^@gran-prix\/markdown$/, replacement: src("packages/markdown") },
      { find: /^@gran-prix\/stats$/, replacement: src("packages/stats") },
      { find: /^@gran-prix\/labels\/testing$/, replacement: src("packages/labels", "testing/index.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Builds the in-page features bundle (collect injects it into Chromium) and a 6-page corpus for the
    // label/dataset stage tests.
    globalSetup: ["test/global-setup.ts"],
    // Collect tests launch Chromium and wait for DOM-quiet windows of >= 600 ms per page.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
