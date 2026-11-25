import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The UI is local-only (served by the studio server, never published). The build lands in dist/ui,
// next to the compiled server, which serves it from /assets and injects the session token into index.html.
export default defineConfig({
  root: fileURLToPath(new URL("./src/ui", import.meta.url)),
  base: "/",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./dist/ui", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
