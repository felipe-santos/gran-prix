import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (dir: string): string => fileURLToPath(new URL(`../../${dir}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the sibling sources, so only the WASM build is a prerequisite.
    alias: {
      "@gran-prix/contracts": src("packages/contracts"),
      "@gran-prix/features": src("packages/features"),
      "@gran-prix/infer-ts": src("packages/infer-ts"),
      "@gran-prix/model": src("packages/model"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Builds the in-page bundle of @gran-prix/features (the collect stage injects it into Chromium).
    globalSetup: ["test/global-setup.ts"],
    // The collect tests launch Chromium and wait for DOM-quiet windows of >= 600 ms per page.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
