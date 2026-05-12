# Gran-Prix Core Map

This document is the technical map of the Rust core. It explains what already exists, how the pieces fit together, and which direction the core should keep following.

Gran-Prix is built around one idea:

```text
small numeric model -> local execution -> deterministic decision
```

The core is not a hosted-model wrapper. It is a native Rust neural engine with tensors, graph execution, autograd, optimizers, persistence, and WASM-facing construction paths.

---

## Mental Model

The runtime flow is:

```text
Tensor
  -> Node
  -> Architecture
  -> ExecutionEngine
  -> Backend
  -> Tensor output
```

The training flow is:

```text
input tensor
  -> graph forward
  -> loss gradient
  -> graph backward
  -> ParamStore gradients
  -> optimizer step
  -> updated parameters
```

The product/runtime flow is:

```text
NetworkDef JSON
  -> compile
  -> Graph + ParamStore
  -> import/export flat weights
  -> WASM Trainer or NeuralBrain
```

---

## Module Map

```text
src/tensor/          Tensor storage, constructors, shape/data access, tensor ops
src/backend/         Backend trait plus CPU implementation and CUDA scaffolding
src/graph/           DAG topology, graph facade, execution engine, ops, verifier
src/layers/          High-level neural layers that build graph nodes
src/loss/            Loss functions and gradients
src/optim.rs         SGD and Adam optimizers
src/scheduler.rs     Learning-rate schedulers
src/params.rs        Parameter store, gradients, names, freezing, flat weights
src/network_def.rs   Declarative architecture contract and compiler
src/types/           Shared identifiers and shape/device types
src/errors.rs        Error model
```

---

## Core Types

### Tensor

Location: `src/tensor/mod.rs`

`Tensor` is the numeric data container. It owns:

- storage;
- shape;
- device identity;
- constructors such as `new_zeros`, `new_random`, `from_elem`, `from_shape_vec`;
- safe slice access for CPU tensors;
- reshape and copy helpers;
- elementwise helpers used by layers, optimizers, and WASM.

Current reliable path: CPU tensors. CUDA support is represented in the storage/backend design but is not the main production path yet.

### Backend

Location: `src/backend/mod.rs`

`Backend` defines physical execution. It is the abstraction layer between graph operations and the device/runtime that performs them.

Implemented operations include:

- matrix multiplication;
- convolution;
- max pooling;
- add/multiply;
- activations;
- backward functions;
- fused `add_relu`;
- parameter update.

The main implementation is `CPUBackend` in `src/backend/cpu.rs`.

### Architecture

Location: `src/graph/architecture.rs`

`Architecture` owns the DAG topology. It contains nodes but no backend, no execution cache, and no optimizer state.

Node kinds:

- `Input(Tensor)`;
- `Param(ParamId)`;
- `Op { op, inputs }`.

Important behavior:

- dense `NodeId` indexing;
- iterative topological sort;
- cycle detection;
- serialization of graph structure.

The iterative sort is important for WASM because it avoids recursion depth issues.

### ParamStore

Location: `src/params.rs`

`ParamStore` owns trainable parameters independently from graph topology.

It supports:

- parameter registration;
- named parameters;
- gradient accumulation;
- freezing/unfreezing by id or name prefix;
- `export_flat`;
- `import_flat`;
- gradient norms;
- total parameter counts;
- serde persistence.

The canonical lightweight persistence path is:

```text
NetworkDef JSON + ParamStore flat weights
```

`import_flat` validates length, finite values, and extreme magnitudes before mutating parameters. This is the trust boundary for model weights loaded from disk, browser storage, network responses, or clipboard data.

### ExecutionEngine

Location: `src/graph/engine.rs`

`ExecutionEngine` owns the backend and execution state:

- cached forward values;
- node gradients;
- training/eval mode;
- deterministic dropout seed counter.

Forward pass:

1. topologically sort the target subgraph;
2. sync parameters into the execution cache;
3. execute each node in dependency order;
4. reuse output buffers when possible.

Backward pass:

1. seed the target node with a loss gradient;
2. walk reverse topological order;
3. call each operation's backward function;
4. accumulate gradients into upstream nodes;
5. forward parameter gradients into `ParamStore`.

### Graph

Location: `src/graph/mod.rs`

`Graph` is the high-level facade:

```text
Graph = Architecture + ParamStore + ExecutionEngine
```

It delegates:

- node construction to `Architecture`;
- parameter ownership to `ParamStore`;
- forward/backward/cache behavior to `ExecutionEngine`.

This split is good and should be preserved. It lets the same architecture/weights be serialized while the backend/runtime cache remains disposable.

### OpType

Location: `src/graph/ops.rs`

`OpType` defines built-in graph operations:

- `MatMul`
- `Conv2D`
- `MaxPool2D`
- `Add`
- `Mul`
- `ReLU`
- `Tanh`
- `Sigmoid`
- `Softmax`
- `Reshape`
- `AddReLU`
- `Dropout`
- `BatchNorm`
- `Custom`

Each operation is responsible for:

- forward pass;
- in-place forward fallback/optimization;
- backward pass;
- output shape inference.

### Layer

Location: `src/lib.rs` and `src/layers/`

`Layer` is the high-level graph-building abstraction. It turns an input `NodeId` into an output `NodeId`.

Implemented layers:

- `Linear`
- `Activation`
- `BatchNorm`
- `RNNCell`
- `GRUCell`

Recurrent layers expose state-related hooks so compiled networks can update hidden state between forward passes.

### NetworkDef

Location: `src/network_def.rs`

`NetworkDef` is the declarative architecture contract.

It is pure data:

```rust
pub struct NetworkDef {
    pub input_dim: usize,
    pub layers: Vec<LayerDef>,
}
```

Supported `LayerDef`s:

- `Linear`
- `Activation`
- `Rnn`
- `Gru`
- `Dropout`
- `BatchNorm`

Its responsibilities:

- validate dimension flow;
- serialize/deserialize architecture JSON;
- compile into `CompiledNetwork`;
- provide `mlp(...)` helpers;
- assign stable parameter names such as `layers[3].weight`.

This is the most important contract for WASM, editor tooling, demos, persistence, and future model exchange.

---

## Training Stack

Losses in `src/loss/mod.rs`:

- `MSE`
- `BinaryCrossEntropy`
- `BCEWithLogits`
- `CategoricalCrossEntropy`
- `CrossEntropyWithLogits`

Optimizers in `src/optim.rs`:

- `SGD`
- `SGD` with momentum and weight decay
- `Adam`

Schedulers in `src/scheduler.rs`:

- `StepLR`
- `ExponentialLR`
- `CosineAnnealingLR`

Canonical training loop:

```rust
let pred = graph.execute(output_node)?;
let grad = loss.gradient(&pred, &target)?;
graph.backward(output_node, grad)?;
optimizer.step_graph(&mut graph)?;
graph.clear_gradients();
```

Batch loops usually accumulate gradients across samples, scale by batch size, and step the optimizer once.

---

## Persistence

There are two persistence paths.

Preferred portable model package:

```text
NetworkDef JSON + flat weights
```

Use:

```rust
let json = net_def.to_json()?;
let weights = graph.params().export_flat()?;

let restored = NetworkDef::from_json(&json)?;
let mut compiled = restored.compile(Box::new(CPUBackend))?;
compiled.graph.params_mut().import_flat(&weights)?;
```

Full graph serde:

```text
Graph serde + set_backend after load
```

This can work, but it couples persistence more tightly to graph internals. Use the JSON+weights pair for anything crossing a boundary.

---

## What Already Exists

The Rust core already has:

- tensor storage and CPU execution;
- DAG graph execution;
- reverse-mode autograd;
- shape verification;
- dense layers and activations;
- CNN operations;
- dropout and batch normalization;
- RNN and GRU cells;
- losses for regression, binary classification, and multi-class classification;
- SGD and Adam;
- LR schedulers;
- parameter naming/freezing;
- flat weight export/import with validation;
- declarative `NetworkDef`;
- WASM-facing construction paths through `NetworkDef`;
- integration tests for gradients, persistence, recurrence, CNN paths, training convergence, and WASM execution paths.

---

## Current Technical Direction

The core should converge around four principles.

### 1. NetworkDef Is The Public Architecture Contract

All external architecture creation should eventually flow through `NetworkDef`.

This includes:

- WASM `Trainer`;
- `NeuralBrain`;
- visual Network Builder;
- saved models;
- examples that want to represent a model as data.

Architecture exchange now goes through `NetworkDef` JSON. Older ad-hoc browser architecture JSON has been removed from the active WASM API.

### 2. Graph Is The Execution Primitive

`Graph` should stay as the live runtime object. It should not become the public interchange format for every use case.

Good split:

```text
NetworkDef = portable architecture
ParamStore flat weights = portable trained state
Graph = executable runtime
ExecutionEngine = disposable backend/cache state
```

### 3. WASM Is A First-Class Runtime

The engine design already reflects WASM constraints:

- iterative graph traversal;
- compact numeric inputs;
- preallocated input buffers in WASM wrappers;
- flat weights;
- deterministic mutation/evolution paths;
- no server requirement.

Future APIs should continue to minimize allocation, panics, and JS/WASM boundary chatter.

### 4. Browser Demos Should Prove Core Concepts

The demo app should not be only entertainment. Each demo should demonstrate a core capability:

- Mouse Hero: local behavioral learning.
- Neural Playground: supervised training and decision boundary visualization.
- Network Builder: `NetworkDef` authoring.
- Flappy/Walker/Predator: evolution or reinforcement-like loops.
- Drone/Oven/Grid: control systems.

---

## Recommended Next Engineering Steps

1. Wire `NetworkBuilder` training/import flows directly to `Trainer.fromNetworkDef`.
   The serializer already emits canonical `NetworkDef` JSON; the remaining work is connecting that output to the actual trainer lifecycle in the UI.
2. Add a small model package helper on the JS side:

   ```ts
   type GranPrixModelPackage = {
     networkDef: string;
     weights: number[];
     metadata?: Record<string, unknown>;
   };
   ```

3. Add a Rust example that demonstrates the canonical package round trip in under 100 lines.
4. Expose a simple verifier path in examples and/or WASM so invalid architecture feedback happens before training.
5. Decide which demo is the flagship product proof and make it use the canonical model package end to end.
