import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (dir: string): string => fileURLToPath(new URL(`../../${dir}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the sibling sources, so only the WASM build is a prerequisite.
    alias: {
      "@gran-prix/contracts": src("packages/contracts"),
      "@gran-prix/infer-ts": src("packages/infer-ts"),
      "@gran-prix/model": src("packages/model"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
