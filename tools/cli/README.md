# @gran-prix/cli (`gp`)

Runs a `PipelineSpec` (ADR-004: pipeline as code) incrementally over a **content-addressed artifact
store**, with a receipt per stage, lineage, and a hard-capped spending ledger. This is the runner
core (E1.7) plus real stages: `collect` and `extract` (E1.5) and `evaluate`, all documented below.
Demo stages (`ts:demo.*`) exercise the runner; label, dataset, train and package plug into the same
interface.

```
gp run <pipeline.json> [--from <stage>] [--to <stage>] [--force] [--data-dir data]
                       [--budget-usd N] [--run-id ID] [--root DIR] [--json]
gp validate <pipeline.json>
gp model check <model-dir> [--runtime ts|wasm] [--json]     # the 9 checks of @gran-prix/model
gp lineage <artifact-id|prefix> [--data-dir data]
gp ledger [--data-dir data] [--budget-usd N]
gp report <eval-report.json> [--extras extras.json] [--compare other.json] [-o out.html]
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

## `gp report`

Renders an `EvalReport` (and the optional extras sidecar) as ONE self-contained HTML file by delegating
to `@gran-prix/report` (`renderReport`). The report is validated with the contracts first (exit 1 with
the failing paths), the extras by `parseExtras` (exit 1), a missing argument is exit 2. `-o` defaults to
`<input name>.report.html` in the current directory; `--compare` takes a second report. The artifacts of
a run are plain files: `<data>/artifacts/sha256-<hex>/content.json` (ids are in the stage receipt).

## The `evaluate` stage (`ts:evaluate.intrinsic@1.0.0`)

Scores one split of a `Dataset` with a `ModelPackage` and writes an `EvalReport` v1.0 (intrinsic). Ports:
inputs `model: ModelPackage`, `dataset: Dataset` (the registry contract) and an optional `many`
`baselines: Bundle`; outputs `report: EvalReport`, `extras: Bundle` (the sidecar `gp report` reads) and
`details: Bundle` (micro and macro-by-page tables with CIs, coverage, bootstrap settings). Deterministic
given the inputs and `seed` (`determinism: seeded`, `runtime: node+wasm`, so the wasm hash is in the cache key).

* Unit = dataset row (element); positive = keep. Weight = characters of own text, recovered from the
  feature `log_own_len` (`round(expm1(x * log1p(5000)))`, override with `params.weight`); `"none"` or a
  model without that feature falls back to weight 1 and says so in the extras notes.
* `by_stratum`, `overall`, `by_label_source`, `baselines` are MICRO (counts summed over pages) as the
  contract implies; macro-by-page (mean of per-page F1) is in `details`, and is the default statistic of
  `comparison[]` and of the gates (`params.aggregation`). Empty output scores P = F1 = 0.
* CIs: percentile bootstrap over clusters (`group_key`, the domain, by default), seeded, `resamples`
  (default 1000), redrawn within strata. Differences model - baseline use the same resample (paired) and
  both systems on the units the baseline covers.
* Baselines: `Bundle` artifacts, JSON `{ id, threshold?, predictions: [{ g, u, p }] }` or a file set with
  `predictions.jsonl` (+ `system.json`); `p` is 0/1 or a score (>= threshold, default 0.5).
* Gates (`params.gates`): `{ id, name?, metric, comparator, threshold, stratum?, baseline?, aggregation?,
  use_ci_lower? }` become `gates[]` (`value` is the CI bound when `use_ci_lower`) and `extras.gate_details`.
  Thresholds are always params; the stage has none of its own.
* The embedded `provenance` is deterministic on purpose (no run id or clock) so artifact ids are stable;
  the real run provenance is in the receipt and `meta.json`.

```
gp run eval.pipeline.json --data-dir data     # params: seed (required), split, resamples, threshold, weight, gates, ...
gp report data/artifacts/sha256-<report>/content.json --extras data/artifacts/sha256-<extras>/content.json -o report.html
```

## Data stages: `collect` and `extract` (E1.5)

```
UrlList --collect--> SnapshotSet --extract--> NodeFeaturesSet          FeatureSchema --^
```

Run from the repo root (relative paths resolve against the working directory):

```
pnpm --filter "@gran-prix/cli..." build        # also builds @gran-prix/features (the in-page bundle)
node tools/cli/dist/bin.js run tools/cli/test/pipelines/mini-collect-extract.pipeline.json --data-dir /tmp/gp-mini
```

**`ts:collect.playwright@1.0.0`** (`node+playwright`, `external`): input `urls: UrlList`, output `snapshots: SnapshotSet`.
Needs a cached Chromium (`GP_CHROMIUM` or `~/.cache/ms-playwright/chromium-*`). One fresh browser context per page,
captured sequentially: load, best-effort networkidle (capped), DOM-quiet settle, stamp `data-gp-id`, probe
(`@gran-prix/features`), flattened html, contract-valid PageSnapshot.

| param | default | meaning |
|---|---|---|
| `viewport` (required) | | `[width, height]` |
| `settle` | `{quiet_ms: 600, max_ms: 8000, network_idle_cap_ms: 3000}` | settle caps |
| `max_nodes` | none | pages with more elements go to `manifest.failures` (`max_nodes`) |
| `nav_timeout_ms` | 30000 | navigation timeout |
| `base_dir` | working directory | base of relative file paths in the UrlList (`StageContext` has no run root yet, so `gp run --root` does not move it) |
| `captured_at` | the clock | pin `capture.captured_at` so a re-collect of an unchanged page gives the same SnapshotSet id |
| `private_suffixes` | true | `alice.github.io` is its own group (false: `github.io`) |
| `fail_on_error` | false | any page that cannot be snapshotted fails the stage |
| `wait` | | free text appended to `capture.wait_strategy` |

**UrlList** (an external, `.json` or any other file): JSON `[{url, stratum, group_key?}]` or `{"urls": [...]}`, or CSV with the
header `url,stratum[,group_key]`. `url` is `http(s)://...`, `file:///abs/p.html`, or a path relative to `base_dir`. A local file
inside `base_dir` is recorded as `file:///<relative path>` (`page.url`, `final_url`, `url_key`), so snapshot ids do not depend on
the checkout location. `stratum` becomes `page.category`. **`group_key`** = the entry's explicit value, else the registrable
domain (eTLD+1, via `tldts` and the Public Suffix List) of the FINAL host, else (local files) the file stem; IPs and `localhost`
keep the host. Pages that fail never disappear silently: navigation errors, `max_nodes`, malformed URLs are listed in
`manifest.failures` and logged; zero snapshots fails the stage.

**Flags** (`capture.flags`, `manifest.entries[].flags`; heuristics over the visible text, outside the snapshot id, never a reason to
drop a page): `http-error` (status >= 400), `error-page`, `captcha`, `paywall`, `tiny-dom` (< 60 elements and < 800 characters).

**`SnapshotSet`** is a file-set artifact:

```
manifest.json            { format: "gran-prix.snapshot-set", entries: [{snapshot_id, url, final_url, stratum, group_key, http_status, flags, node_count, snapshot, html}], failures: [...] }
snapshots/<hex>.json     contract-valid PageSnapshot (extensions: top-level text_units and probe; capture.flags, capture.settle)
html/<hex>.html.gz       flattened rendered html, gzip
```

**Flattened html** (for the label stage, which parses it in jsdom): the live DOM after stamping, serialized from a clone. Every OPEN
shadow root is inlined (its children are prepended to the host, the composed pre-order the ids use); every `data-gp-id="n<idx>"`
attribute is kept, so `[data-gp-id="n<k>"]` exists for every `nodes[k]` and is unique; every `<script>` is emptied (no source, no
attributes but its id, no text) but kept, because the probe numbers it. Not inlined (and without ids): closed shadow roots, iframe
documents, `<template>` content. `snapshot.html` is `{path, sha256, bytes, media_type: "text/html", content_encoding: "gzip"}` where
`sha256` and `bytes` describe the DECODED html (gzip bytes vary between zlib builds and must not enter `snapshot_id`).
`SnapshotSetReader` (`src/stages/collect-stages.ts`) reads all of it: `entries()`, `snapshot(entry)`, `html(entry)`.

**Determinism.** The volatile capture data is kept out of the id: `captured_at`, timings, mutation counts and the networkidle outcome
are in the log or in `capture`, never in `snapshot_id`; the stored `capture.settle` keeps only `reason`, `shadow_roots`,
`tracked_from_start`, `late_unstamped`. A forced re-collect of the fixtures gives the same snapshot ids, and with `captured_at`
pinned the same SnapshotSet id (tested).

**`ts:extract.dom-node@1.0.0`** (`node`, `pure`): inputs `snapshots: SnapshotSet` + `schema: FeatureSchema`, output
`features: NodeFeaturesSet`. Applies the pure `vectorize` of `@gran-prix/features` to every snapshot and validates each NodeFeatures
against the contract. `NodeFeaturesSet` is a file-set artifact: `manifest.json` (`feature_schema_id`, entries with `snapshot_id`,
`features_id`, `group_key`, `stratum`, `flags`, `n_rows`, `features`) plus `features/<hex>.json` (one NodeFeatures per snapshot,
`<hex>` = its snapshot id).

**Where the FeatureSchema comes from.** It is an *external* of the pipeline; no helper stage is needed:

```json
"externals": {
  "urls":   { "type": "UrlList",       "path": "tools/cli/test/pipelines/mini-urls.json" },
  "schema": { "type": "FeatureSchema", "path": "packages/features/src/schema/feature-schema.v0.json" }
}
```

A `.json` external is stored as a JSON artifact (`--root` moves the base of `path`); pin it with `"id"` if the pipeline must refuse any other
schema. See `tools/cli/test/pipelines/mini-collect-extract.pipeline.json`.

## Tests

```
node scripts/build-wasm.mjs --target both --web-out packages/wasm/dist/web --node-out packages/wasm/dist/node
pnpm --filter @gran-prix/cli test        # runs against the sibling sources; needs only the WASM build
pnpm --filter @gran-prix/cli... build    # contracts, infer-ts, model, report, cli (typecheck needs the first four built)
pnpm --filter @gran-prix/cli test        # runs against the sibling sources; needs the WASM build and a cached Chromium (the collect tests)
pnpm --filter @gran-prix/cli... build    # contracts, infer-ts, model, features, cli (typecheck needs the first four built)
```
