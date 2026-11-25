import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests import the contracts from source, so a clean clone needs no prior
// `pnpm --filter @gran-prix/contracts build`.
const contractsSrc = fileURLToPath(new URL("../contracts/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@gran-prix/contracts": contractsSrc } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globalSetup: ["test/global-setup.ts"],
    // Chromium launches and settle windows (>= 600 ms per page) live in these tests.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
