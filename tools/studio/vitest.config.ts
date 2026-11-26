import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (dir: string, file = "index.ts"): string => fileURLToPath(new URL(`../../${dir}/src/${file}`, import.meta.url));

// Tests run against the sibling sources, so a clean clone needs no prior build of the workspace packages
// (the headless smoke test additionally needs Chromium and the built UI, see test/global-setup.ts).
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@gran-prix\/contracts$/, replacement: src("packages/contracts") },
      { find: /^@gran-prix\/features$/, replacement: src("packages/features") },
      { find: /^@gran-prix\/labels$/, replacement: src("packages/labels") },
      { find: /^@gran-prix\/markdown$/, replacement: src("packages/markdown") },
      { find: /^@gran-prix\/infer-ts$/, replacement: src("packages/infer-ts") },
      { find: /^@gran-prix\/model$/, replacement: src("packages/model") },
      { find: /^@gran-prix\/report$/, replacement: src("packages/report") },
      { find: /^@gran-prix\/cli$/, replacement: src("tools/cli") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 240_000,
  },
});
