import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import path from 'path'

// Single WASM build (web target) produced by `node scripts/build-wasm.mjs`
// (see packages/wasm). Nothing generated is committed to the repository.
const wasmWebDir = path.resolve(__dirname, '../packages/wasm/dist/web')

// https://vitejs.dev/config/
export default defineConfig({
  base: '/gran-prix/',
  plugins: [
    react(),
    wasm(),
    topLevelAwait()
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@gran-prix/wasm': path.join(wasmWebDir, 'gran_prix_wasm.js'),
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-recharts': ['recharts'],
          'vendor-ui': ['lucide-react', 'clsx', 'tailwind-merge'],
        }
      }
    }
  },
  server: {
    fs: {
      // Serve demo-web itself plus the built WASM package (../packages/wasm/dist)
      allow: [__dirname, path.resolve(__dirname, '../packages')],
    },
  },
})
