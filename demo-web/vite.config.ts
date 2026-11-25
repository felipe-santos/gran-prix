import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import path from 'path'

// `@gran-prix/wasm` is a pnpm workspace dependency (packages/wasm) whose entry points
// at dist/web, produced by `pnpm build:wasm`. Nothing generated is committed.

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
      // Serve demo-web itself plus the linked WASM package (../packages/wasm/dist)
      allow: [__dirname, path.resolve(__dirname, '../packages')],
    },
  },
})
