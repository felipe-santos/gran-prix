# @gran-prix/wasm

Single build of the `gran-prix-wasm` bridge. Nothing generated is committed to
the repository: consumers (demo-web, the Node scripts, CI, the Pages deploy)
all use the output of this package.

## Build

Requires Rust stable with the `wasm32-unknown-unknown` target and `wasm-pack`.

```bash
# from the repository root
node scripts/build-wasm.mjs --target both \
  --web-out packages/wasm/dist/web --node-out packages/wasm/dist/node

# or, equivalent
cd packages/wasm && npm run build
```

## Output (gitignored)

| Directory | Target | Used by |
| --- | --- | --- |
| `dist/web` | ES module + `initSync` | `demo-web` (alias `@gran-prix/wasm`) |
| `dist/node` | CommonJS | `demo-web/scripts/smoke-test.mjs`, `seeded-init-check.mjs` |

Both directories contain `gran_prix_wasm.d.ts`, so TypeScript sees the types.

## Consuming

- demo-web resolves `@gran-prix/wasm` to `packages/wasm/dist/web` through a Vite
  alias and a `tsconfig` `paths` entry (no npm workspace yet).
- Node scripts read `packages/wasm/dist/node` by default; set
  `GRAN_PRIX_WASM_NODE` to point them at another directory.
- Size budget: `node scripts/check-wasm-size.mjs packages/wasm/dist/web/gran_prix_wasm_bg.wasm`.
