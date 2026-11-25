# @gran-prix/cli (`gp`)

Runs a `PipelineSpec` (ADR-004: pipeline as code) incrementally over a **content-addressed artifact
store**, with a receipt per stage, lineage, and a hard-capped spending ledger. This is the runner
core (E1.7, wave 2): only demo stages ship now (`ts:demo.*`); the real stages (collect, extract,
label, dataset, train, evaluate, package) plug into the same interface in wave 3.

```
gp run <pipeline.json> [--from <stage>] [--to <stage>] [--force] [--data-dir data]
                       [--budget-usd N] [--run-id ID] [--root DIR] [--json]
gp validate <pipeline.json>
gp model check <model-dir> [--runtime ts|wasm] [--json]     # the 9 checks of @gran-prix/model
gp lineage <artifact-id|prefix> [--data-dir data]
gp ledger [--data-dir data] [--budget-usd N]
```

Exit status: 0 ok, 1 failed (invalid pipeline, failed stage, failed check), 2 usage error.
`data/` is gitignored; tests always use a temp data dir.

```
$ pnpm --filter @gran-prix/cli build
$ node tools/cli/dist/bin.js run tools/cli/examples/demo.pipeline.json --budget-usd 1 --data-dir /tmp/gp-demo
$ node tools/cli/dist/bin.js run tools/cli/examples/demo.pipeline.json --budget-usd 1 --data-dir /tmp/gp-demo   # all cached
```

## How a run works

1. The spec is validated by the contracts (`validate("pipeline-spec")`, then `pipelineRegistryIssues`:
   known impl, `params` against `params_schema`, ports, port types, seed for seeded stages). Nothing is
   written when it is invalid.
2. `${vars.x}` is resolved; stages are ordered topologically (declaration order breaks ties).
3. Per stage: `cache_key = stageCacheKey({ kind, impl, params, inputIds, wasmSha? })`. `wasmSha` is
   the sha256 of the loaded `.wasm` and only enters the key of `node+wasm` stages. On a hit
   (`<data>/cache/<key>.json` whose artifacts are all in the store) the stage is not executed.
   On a miss the plugin runs and every output is stored.
4. Receipts go to `<data>/runs/<run_id>/<stage_id>/stage.json` (status `ran` / `cached` / `failed` /
   `skipped`, inputs, outputs, cache key, params hash, impl and version, duration, cost, error) and a
   `run.json` summary plus a copy of the spec.

| flag | meaning |
|---|---|
| `--from A` | run A and everything downstream; upstream stages are resolved from the cache only (a miss fails the run, nothing upstream is executed) |
| `--to B` | run B and its ancestors; the rest is `out-of-range` |
| `--force` | re-run every selected stage even on a hit (cache entries rewritten); ids come out identical for deterministic stages |
| stage `cache: "refresh"` / `"off"` | always re-run / never read or write the cache entry |
| stage `gate: true` | when it fails, the whole run is aborted (remaining stages `skipped`) |

A failed stage leaves a `failed` receipt (error name and message), its downstream stages are
`skipped` with a receipt saying why, independent branches still run (unless a gate failed), and the
exit status is 1. Failures are never cached.

## Artifact store

`<data>/artifacts/sha256-<hex>/` (the id with `:` replaced by `-`, a portable file name):

* JSON artifact: `content.json` (canonical JSON), id = `artifactId(value)` (RFC 8785);
* file-set artifact: `files/<path>`, id = `artifactId({ v, type, files: { path: sha256(bytes) } })`;
* `meta.json`: type and the provenance of the FIRST producer (`Provenance` of the contracts: stage,
  params hash, cache key, input ids, pipeline spec id, tool versions). Outside every id.

Writes are atomic and idempotent, so ids and bytes are stable across runs, data dirs and `--force`.
`gp lineage` walks the sidecars up to the external inputs. Externals (`externals[].path`) are loaded
into the store (`.json` as JSON artifacts, anything else as a one-file set) and enter cache keys by id.

## Ledger and budget

`<data>/ledger.jsonl` is append-only. Any stage that spends money must call
`ctx.ledger.reserve(costUSD, note)` BEFORE the paid call; it throws `BudgetExceededError` (and logs a
`reject` line) when `spent + cost > cap`, then `commit(actualUSD?)` or `release()`. Open reservations
count against the cap (a crash cannot hide spending). The cap is `--budget-usd` / `GP_BUDGET_USD` and
defaults to **0**, so no paid stage runs without an explicit budget. Totals are cumulative over the data
dir. A cache hit never calls the stage, so re-running an unchanged pipeline spends nothing.

## Writing a stage

```ts
import { defineStage } from "@gran-prix/cli";

export const myStage = defineStage(
  {
    kind: "label",
    impl: "ts:label.example@1.0.0",            // exact version: part of the cache key
    inputs: [{ name: "snapshots", type: "SnapshotSet" }],
    outputs: [{ name: "labels", type: "NodeLabelsSet" }],
    params_schema: { type: "object", required: ["seed"], properties: { seed: { type: "integer" } } },
    runtime: "node",                            // "node+wasm" adds the wasm sha to the cache key
    determinism: "seeded",                      // seeded stages must have a `seed` param
  },
  async (ctx) => {
    const input = ctx.inputs["snapshots"];      // ArtifactHandle (array for `many` ports)
    return { labels: { json: {/* ... */} } };   // or { files: { "path": bytes } }
  },
);
```

A stage must be a function of its resolved params and input artifacts (plus the wasm binary):
the cache key assumes nothing else matters. Demo stages: `emit-json`, `emit-files`, `concat`,
`fail`, `spend`.

## Tests

```
node scripts/build-wasm.mjs --target both --web-out packages/wasm/dist/web --node-out packages/wasm/dist/node
pnpm --filter @gran-prix/cli test        # runs against the sibling sources; needs only the WASM build
pnpm --filter @gran-prix/cli... build    # contracts, infer-ts, model, cli (typecheck needs the first three built)
```
