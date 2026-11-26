# Known gaps

Properties of the system consumers must factor into how they use the
API, plus the small set of items that remain explicitly deferred.

## Behavioral properties consumers must understand

These are not bugs and not deferred work — they're properties of the
design.

### `Trainer` is binary or multi-class, not both at the same time

`Trainer` auto-detects [`LossKind`] from `output_dim` at construction:
single output → binary (BCE), more than one → multi-class (CCE). The
auto-detection rule is centralized in `LossKind::from_output_dim`.

If the auto-detection isn't right (a 2-class problem expressed as two
binary heads, for instance), use [`Trainer::from_network_def_with_loss`]
to pick explicitly.

The methods are split by mode:

  - Binary: `train_batch`, `train_step`, `predict`, `predict_batch`.
  - Multi-class: `train_batch_multi_class`, `predict_class`,
    `predict_class_with_threshold`, `predict_probs`,
    `predict_probs_batch`.

Calling a binary method on a multi-class trainer (or vice versa)
returns an error rather than silently producing wrong outputs.
`predict_probs` / `predict_class` work in both modes, dispatching on
`loss_kind`.

### Recurrent hidden state is not part of the persistence contract

`RNNCell::hidden_state` and `GRUCell::hidden_state` are
`#[serde(skip)]`. The `(NetworkDef.json, flat weights)` round-trip
preserves trainable weights and architecture, **not** mid-episode
recurrent state. Consumers that need to resume mid-episode persist
the hidden state out of band.

Pinned by `tests/persistence_e2e.rs::known_gap_contract_json_carries_no_hidden_state`
and the parallel test for RNN.

### Per-node gradients are per `backward` call

`ExecutionEngine::backward` clears per-node gradients at the start of every
call. Parameter gradients still accumulate in `ParamStore` across calls until
`clear_gradients`, which is what makes per-sample batch loops correct:
clear once per batch, then forward + backward per sample, then one optimizer
step. `get_node_gradient` returns the values of the last call only.

Pinned by `tests/batch_gradient_accumulation.rs`.

### `Trainer` switches training/eval mode itself

`train_batch` and `train_batch_multi_class` (and `train_step`, which
delegates) run in training mode, so Dropout is active; every `predict*` path
runs in eval mode. Training mode is restored to eval on both the success and
the error path. Pinned by `gran-prix-wasm/src/trainer/tests.rs` and the smoke
test.

### Seeded initialization is opt-in

`NetworkDef::compile` keeps random initialization. Reproducible weights come
from `NetworkDef::compile_seeded(backend, seed)` (Rust) or
`Trainer.fromNetworkDefSeeded(json, seed)` /
`Trainer.fromNetworkDefWithLossSeeded(json, lossKind, seed)` (WASM, `u32`
seed). Streams are ChaCha8, one per layer, independent of the thread RNG.
Pinned by golden values in `tests/seeded_init_tests.rs`; changing the init
algorithm requires updating them deliberately.

### Trainer trust boundaries are asymmetric

`ParamStore::import_flat` validates inputs (finite + magnitude cap).
`ParamStore::accumulate_gradient` and `ParamStore::set_gradient` do
**not** validate — they're called by the engine's backward pass,
which is in the trust zone. Documented at
`params::tests::test_accumulate_gradient_does_not_validate_input`.

### `BatchNorm` has no running statistics

`BatchNorm` (`src/layers/batchnorm.rs`) computes batch statistics
fresh from each forward's input. There is no accumulated running
mean / variance. Consequence: single-sample inference (`predict`)
produces a different output than batched inference
(`predict_batch` with `B > 1`) for the same row, because BN with one
sample falls back to ~affine while BN with multiple rows uses the
batch's real statistics.

Pinned by
`tests/persistence_e2e.rs::batchnorm_output_differs_between_single_and_batched_forwards`.

### `NeuralBrain` and `CompiledNetwork` use the same recurrence plumbing

Both `gran_prix::network_def::CompiledNetwork::update_states` and
`gran-prix-wasm::brain::NeuralBrain::compute_internal` propagate the
post-forward hidden state into the graph's previous-state input node
(via `Layer::prev_state_input()`) and clear the engine's value cache.
Without that propagation, recurrence over multiple consecutive forwards
through the same compiled graph would silently use the original (zero)
initial state every time.

Pinned by `tests/recurrence_e2e.rs`.

### Repo-wide formatting is not enforced

`cargo fmt --check` reports pre-existing diffs across many unmodified
files (`examples/*.rs`, `src/graph/*.rs`, etc.). Code added in the
implementation rounds follows the local convention of the file it
lives in. Repo-wide cleanup is deferred; see below.

## Deferred until product direction or specific demand

### Cross-version compatibility test for `(NetworkDef.json, flat weights)`

Scope: a test that proves a v1 schema artifact loads correctly under
a v2 build, and vice versa for forward-compatible changes.

Why deferred: there's no schema versioning yet. Inventing one
requires a real distribution use case (e.g., shipping pre-trained
models with the extension and updating the backbone over time).

Triggering condition: a distribution use case appears.

### Repo-wide `cargo fmt` cleanup

Scope: run `cargo fmt` across the whole repo, accept the resulting
diff, add a CI gate enforcing `cargo fmt --check`.

Why deferred: large blast radius across files unrelated to any
current change. Best done as a single dedicated cleanup PR.

Triggering condition: someone owns a cleanup pass.

### `predict_batch` pre-allocated batch buffer

`predict_batch` and `predict_probs_batch` snapshot the input node,
allocate a `[batch_size, input_dim]` tensor, run the forward, and
restore the snapshot. For workloads that call them thousands of
times with the same `batch_size`, keeping a pre-allocated batch
tensor on the `Trainer` would eliminate the per-call allocation.

Why deferred: no observed workload calls predict_batch in a hot loop.
Current cost is negligible (one tensor alloc per call) for the
documented use cases.

Triggering condition: profiling shows allocation overhead matters.

### Headless-Chrome WASM test runner

Scope: a `wasm-pack test --headless --chrome` configuration so WASM
tests run in a real browser environment.

Why deferred: the only cross-language smoke test today
(`demo-web/scripts/smoke-test.mjs`) runs in Node and exercises the
WASM bridge surface area without needing a browser DOM. Browser
testing matters specifically for code that uses
`getBoundingClientRect`, computed style, etc. — code that doesn't
exist yet.

Triggering condition: extension content script exists and uses
browser APIs the test must exercise.

### Profile-change measurement gate (process)

Scope: a CI step that runs benchmarks of representative demos before
and after any change to `gran-prix-wasm/Cargo.toml`'s
`[profile.release]` and fails the build on regressions beyond a
threshold.

Why deferred: process improvement, not code. The lesson — "do not
change the release profile without measuring" — is documented.

### Training is bit-reproducible per platform, not across platforms

`gp-train` produces byte-identical weights for the same inputs, config and seed on one machine (the E1 gate checks
this across data dirs). Across machines the weights can differ in the last bits: `f32::exp`/`ln`/`tanh` come from the
system libm (glibc picks FMA or non-FMA variants per CPU), and gradient descent amplifies a last-bit difference.
Inference is unaffected in practice (the runtimes agree with the golden within 1e-5), but a model's `model_id` is only
reproducible on the platform that trained it. Tests that pin hashes of trained weights run only with
`GP_TRAIN_PINNED_PLATFORM=1`. A portable libm (for example the `libm` crate) would remove this, at some speed cost.

### Dependency freeze on the measurement path while the dom-v0 experiment runs

The pre-registered experiment `dom-v0` (tag `prereg-dom-v0`) pins the capture browser and the baselines. Until it
ends, these stay at their locked versions even when Dependabot proposes updates: `playwright-core` (and so the
Chromium revision), `jsdom`, `@mozilla/readability`, `defuddle`, `tinyld`, the Python `trafilatura`/`scikit-learn`
pins in `tools/baselines/requirements*.txt`, and the token converter/tokenizer once they land. Updates outside that
path (Rust patch releases, CI actions, demo-web) are taken normally.

### demo-web dependency refresh is blocked by `vite-plugin-top-level-await`

An in-range refresh of demo-web's dependencies breaks its production build: `vite-plugin-top-level-await` 1.6.0 fails
with `@swc/core` 1.16 ("missing field `type`") and, with `@swc/core` held back, with esbuild 0.28 (destructuring for the
`chrome87`/`safari14` target). The fix is to drop the plugin (Vite 7 handles top-level await with
`build.target: "esnext"` or `es2022`) and then take the updates. The open Dependabot PRs for demo-web wait on that.

### `DEFAULT_SPLIT_RANGES` is not the dom-v0 split

`@gran-prix/contracts`' `DEFAULT_SPLIT_RANGES` (train 0-70, val 70-85, test 85-100) is a general default. The dom-v0
protocol uses train [0,55), val [55,70), test [70,100): pass the ranges explicitly, as `tools/corpus` does.

### The CDP CPU throttle understates long tasks, and the G5 latency is far over its limit

`ts:measure.latency` throttles the CPU with `Emulation.setCPUThrottlingRate`. In the pinned Chromium a ~100 ms task gets
only about 1.9-2.4x slower at rate 4, so the default `throttle: "cdp-rate"` gives optimistic numbers. The opt-in
`throttle: "calibrated"` searches for the rate that makes a reference loop 4x slower, and it records the search plus a
second check after the pages. On a shared, loaded machine that check drifts a lot (1.0x to 13.7x were seen), so a
calibrated run counts only when both checks land within 4 +- 0.5. The most stable figure on such a machine is the 1x
run times 4. Even after the probe and vectorize work (same output, about 25-30% faster), the 4x p95 is several hundred
ms against the 150 ms limit. Static flattened pages are an approximation too: the real G5 is measured in the extension.

## Items closed

Closed in stage E0 (2026-11):

  - **Gradient leak across backward calls (P0).** Per-node gradients
    survived a `backward` call and were added into the next one, so every
    batch trained through the WASM `Trainer` mixed one sample's gradient into
    the next sample's activations (separable-task accuracy 3-13% at lr 0.01;
    now 99%+).
  - `Trainer` training/eval mode handling (Dropout was never active).
  - Seeded, version-stable weight initialization.
  - `Population` best-agent selection for all-negative and NaN fitness.
  - Size-optimized WASM build (`scripts/build-wasm.mjs`) with a size budget
    check and a CI workflow (`.github/workflows/ci.yml`).

Earlier rounds:

For audit trail, items the implementation rounds explicitly closed.
Each is now pinned by tests that would fail if the behavior regressed.

  - `Trainer::networkDefJson()` getter
  - `Trainer::predictBatch` real batched (single forward, snapshot/restore)
  - `Trainer::freezeByPrefix` / `unfreezeByPrefix` (return indices),
    `paramCount`, `paramName`, `paramNames`, `isFrozenByIndex`
  - Multi-class `Trainer`: `LossKind` enum, `predict_probs`,
    `predict_class`, `predict_class_with_threshold`,
    `predict_probs_batch`, `train_batch_multi_class`,
    `from_network_def_with_loss`, terminal-activation/loss-compat
    validation
  - `serde_json::to_string(&Graph)` for trained models — covered for
    MLP, BatchNorm, Dropout, RNN (fresh state), GRU (fresh state)
  - Recurrent state-update plumbing in `CompiledNetwork::update_states`
    and `NeuralBrain::compute_internal` — both fixed; `Layer::prev_state_input`
    is a required trait method (not a default-no-op) so future stateful
    layers can't silently regress.
  - `CompiledNetwork::reset_states` is now a complete reset (zeroes
    the graph's previous-state input nodes and clears the cache).
  - `Layer::set_name_prefix` and `prev_state_input` are required trait
    methods for consistency.
  - `ParamStore::import_flat` validates finite + magnitude with
    boundary tests.
  - `convert_legacy_architecture` correctly maps `dropout` /
    `batchnorm` to the corresponding `LayerDef` instead of silently
    skipping.
