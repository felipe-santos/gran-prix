# Gran-Prix Web Laboratory

This is the browser-facing showcase for Gran-Prix. It is a **React + Vite + WebAssembly** app that demonstrates small neural systems running locally in the user's browser.

The app is not just one game demo anymore. It is a visual lab for real-time inference, training, evolution, and model inspection.

---

## What lives here

- A landing page with the mouse-behavior hero demo.
- Multiple interactive simulations: oven control, vacuum navigation, trading, smart grid routing, drone stabilization, predator/prey, walking agents, Flappy Bird RL, and more.
- Shared React components for stats, charts, canvases, controls, and network visualization.
- WASM loader utilities that connect the JavaScript simulation loop to the Rust neural core.

Related technical docs:

- [`../docs/core-map.md`](../docs/core-map.md): Rust core architecture.
- [`../docs/wasm-contract.md`](../docs/wasm-contract.md): browser/WASM model contract.

---

## Prerequisites

- Node.js 18+
- Rust stable
- `wasm-pack`

Install `wasm-pack` if needed:

```bash
cargo install wasm-pack
```

---

## Run locally

From the repository root, build the WASM bindings. The app imports them as `@gran-prix/wasm`, which resolves to `packages/wasm/dist/web` (gitignored, never committed):

```bash
node scripts/build-wasm.mjs --target both \
  --web-out packages/wasm/dist/web --node-out packages/wasm/dist/node
```

Then start the web app:

```bash
cd demo-web
npm install
npm run dev
```

Open the Vite URL, usually:

```text
http://localhost:5173
```

---

## Build

Build the WASM first (previous section), then:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

---

## How the loop works

```text
Canvas / UI state
    -> compact numeric features
    -> WASM neural brain
    -> prediction / action
    -> simulation step
    -> charts, stats, network visualization
```

The important constraint: raw high-frequency behavioral or simulation data does not need to leave the browser. The model can infer, train, mutate, and export compact state locally.

---

## Demo catalog

The demo list is configured in:

```text
src/config/demos.ts
```

Each demo typically has:

- `src/components/<demo>/` for React UI pieces.
- `src/demos/<demo>/` for simulation logic.
- `src/hooks/use<Demo>Wasm.ts` or `use<Demo>GameLoop.ts` for runtime integration.
- `src/config/<demo>.config.ts` for tuning constants.

---

## Product direction

The strongest public story for this app is:

> A real neural model is running in your browser, learning from local signals, and adapting the experience without sending raw behavior to a server.

The mouse-behavior hero and Neural Playground should be treated as the primary proof points. The other simulations support the same thesis across control systems, reinforcement learning, and multi-agent environments.

Technically, new builder/trainer work should converge on the canonical model package:

```ts
{
  networkDef: string;
  weights: number[];
  metadata?: Record<string, unknown>;
}
```

Network Builder exports should target `Trainer.fromNetworkDef`.
