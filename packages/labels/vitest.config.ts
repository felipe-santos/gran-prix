import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (dir: string): string => fileURLToPath(new URL(`../${dir}/src/index.ts`, import.meta.url));

// Tests run against the sibling sources, so a clean clone needs no prior build of contracts or features.
export default defineConfig({
  resolve: { alias: { "@gran-prix/contracts": src("contracts"), "@gran-prix/features": src("features") } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 240_000,
  },
});
