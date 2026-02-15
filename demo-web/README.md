# Gran-Prix: Neural Racer Demo

This is a **React + Vite** application that visualizes the Gran-Prix AI engine running in the browser using WebAssembly.

## Prerequisites

- Node.js (v18+)
- Rust (latest stable)
- `wasm-pack` (`cargo install wasm-pack`)

## Setup Instructions

### 1. Build the WASM Module
First, compile the Rust code to WebAssembly.

```bash
cd ../gran-prix-wasm
wasm-pack build --target web
```
This will create a `pkg` directory inside `gran-prix-wasm`.

### 2. Install Frontend Dependencies
Navigate back to this directory (`demo-web`) and install the Node packages.

```bash
cd ../demo-web
npm install
```

### 3. Run the Development Server
Start the local server to see the demo.

```bash
npm run dev
```
Open your browser at `http://localhost:5173`.

## Architecture
- **Rust/WASM (`../gran-prix-wasm`)**: Contains the `NeuralBrain` struct and the `gran-prix` engine logic.
- **React (`src/App.tsx`)**: Handles the game loop (Canvas), renders the UI, and calls `NeuralBrain` methods.
- **Communication**: The app passes a `Float32Array` of sensor data to WASM and receives a steering value.
