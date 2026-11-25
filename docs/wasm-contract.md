# WASM Contract

This document defines how the browser-facing code should talk to the Gran-Prix Rust core.

The short version:

```text
Use NetworkDef JSON for architecture.
Use flat weights for trained parameters.
Use Trainer for online supervised training.
Use NeuralBrain / Population for evolutionary agents.
```

---

## Canonical Model Package

The preferred browser/package format is:

```ts
type GranPrixModelPackage = {
  networkDef: string;
  weights: number[];
  metadata?: {
    name?: string;
    createdAt?: string;
    task?: string;
    inputLabels?: string[];
    outputLabels?: string[];
  };
};
```

Where:

- `networkDef` is `NetworkDef::to_json()`;
- `weights` is `ParamStore::export_flat()`;
- `metadata` is UI/product information only.

Restore flow:

```ts
const trainer = Trainer.fromNetworkDef(model.networkDef);
trainer.import_weights(model.weights);
```

The same idea applies on the Rust side:

```rust
let net = NetworkDef::from_json(&network_def_json)?;
let mut compiled = net.compile(Box::new(CPUBackend))?;
compiled.graph.params_mut().import_flat(&weights)?;
```

---

## NetworkDef JSON

Canonical architecture JSON is produced by the Rust core and accepted by WASM.

Example:

```json
{
  "input_dim": 2,
  "layers": [
    { "type": "linear", "in_features": 2, "out_features": 8 },
    { "type": "activation", "function": "relu" },
    { "type": "linear", "in_features": 8, "out_features": 1 }
  ]
}
```

Supported layer definitions:

- `linear`
- `activation`
- `rnn`
- `gru`
- `dropout`
- `batchnorm`

Important convention: binary classifiers should usually output logits, not sigmoid probabilities, when trained with `BCEWithLogits`.

---

## Trainer

Location: `gran-prix-wasm/src/trainer/` (split by concern: `build`, `training`, `params`, `inference`, `forward`, `loss_kind`)

`Trainer` is the WASM API for online supervised learning.

Construction paths:

- `new(inputDim, hiddenLayers)`  
  Creates a simple binary MLP for playground-style demos.

- `Trainer.fromNetworkDef(json)`  
  Preferred constructor for custom architectures.

- `Trainer.fromNetworkDefWithLoss(json, lossKind)`  
  Use when auto-detection is not the desired behavior.

Persistence methods:

- `networkDefJson()`
- `get_weights()`
- `import_weights(weights)`

Training methods:

- `train_batch(inputs, targets, lr)` for binary mode;
- `trainBatchMultiClass(inputs, classIndices, lr)` for multi-class mode;
- `train_step(features, target, lr)` for a single binary sample.

Prediction methods should be chosen according to output mode. Binary helpers apply sigmoid to logits where appropriate.

---

## Loss Selection

The WASM trainer auto-detects loss mode from `NetworkDef.output_dim()`:

```text
output_dim == 1 -> BinaryCrossEntropy mode
output_dim > 1  -> CategoricalCrossEntropy mode
```

The implementation validates terminal activations:

- `BCEWithLogits` expects raw logits, so a final sigmoid is rejected for that mode.
- `CrossEntropyWithLogits` expects raw logits, so a final softmax is rejected for that mode.

Reason: the numerically stable loss already applies the sigmoid/softmax logic internally.

---

## NeuralBrain

Location: `gran-prix-wasm/src/brain.rs`

`NeuralBrain` is optimized for evolutionary agents and hot-path inference.

It uses:

- `NetworkDef::mlp(...)` internally;
- deterministic weight initialization;
- flat weight export/import;
- preallocated input/output tensors;
- corruption and re-entrancy checks;
- optional recurrent-state plumbing through compiled stateful layers.

Use `NeuralBrain` when the demo is agent/population oriented:

- Flappy agents;
- predator/prey;
- walker;
- car evolution;
- drone policy population.

Use `Trainer` when the demo is supervised learning:

- classifier playground;
- mouse behavior prediction;
- local lead scoring;
- behavior classification.

---

## Network Builder Export

The Network Builder export target is:

```text
Network Builder graph -> NetworkDef JSON -> Trainer.fromNetworkDef
```

---

## Browser Integration Rules

Prefer this:

```text
compact features -> WASM -> numeric prediction -> UI/simulation action
```

Avoid this:

```text
raw high-frequency event stream -> backend -> remote inference -> UI action
```

Keep JS/WASM calls coarse enough to avoid boundary overhead:

- batch training examples where possible;
- export/import weights as flat arrays;
- keep architecture as one JSON string;
- do not ask WASM for per-neuron detail every animation frame unless the visualization needs it.

---

## Direction

The target architecture is:

```text
Network Builder
  -> exports NetworkDef JSON
  -> Trainer.fromNetworkDef
  -> trains locally
  -> exports { networkDef, weights, metadata }
  -> can reload, inspect, mutate, or ship as a static asset
```

This makes the web app, Rust examples, persistence tests, and future product demos all speak one language.
