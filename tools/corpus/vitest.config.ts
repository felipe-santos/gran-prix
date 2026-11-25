import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run against the sibling sources: no build of @gran-prix/contracts is needed.
    alias: [{ find: /^@gran-prix\/contracts$/, replacement: fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url)) }],
  },
  test: { include: ["test/**/*.test.mjs"], environment: "node" },
});
