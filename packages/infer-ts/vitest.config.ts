import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Parity tests train WASM networks; give them room.
    testTimeout: 60_000,
  },
});
