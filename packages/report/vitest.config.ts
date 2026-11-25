import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // the CLI tests spawn node once per case; a loaded CI machine can take longer than the 5 s default
    testTimeout: 30_000,
  },
});
