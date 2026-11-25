# @gran-prix/wasm

Single build of the `gran-prix-wasm` bridge. Nothing generated is committed to
the repository: consumers (demo-web, the Node scripts, CI, the Pages deploy)
all use the output of this package.

## Build

Requires Rust stable with the `wasm32-unknown-unknown` target and `wasm-pack`.

```bash
# from the repository root
pnpm build:wasm

# or, equivalent
node scripts/build-wasm.mjs --target both \
  --web-out packages/wasm/dist/web --node-out packages/wasm/dist/node
```

## Output (gitignored)

| Directory | Target | Used by |
| --- | --- | --- |
| `dist/web` | ES module + `initSync` | `demo-web` (workspace dependency `@gran-prix/wasm`) |
| `dist/node` | CommonJS | `demo-web/scripts/smoke-test.mjs`, `seeded-init-check.mjs` |

Both directories contain `gran_prix_wasm.d.ts`, so TypeScript sees the types.

## Consuming

- demo-web declares `"@gran-prix/wasm": "workspace:*"` (pnpm workspace). The
  package entry points (`main`/`types`/`exports`) resolve to `dist/web`, so Vite
  and `tsc` need no alias or `paths` entry.
- Node scripts read `packages/wasm/dist/node` by default; set
  `GRAN_PRIX_WASM_NODE` to point them at another directory.
- Size budget: `node scripts/check-wasm-size.mjs packages/wasm/dist/web/gran_prix_wasm_bg.wasm`.
