# @gran-prix/cli (`gp`)

Runs a `PipelineSpec` (ADR-004: pipeline as code) incrementally over a **content-addressed artifact
store**, with a receipt per stage, lineage, and a hard-capped spending ledger. This is the runner
core (E1.7) plus the real stages: `collect` and `extract` (E1.5), `train` (gp-train) and `package`
(deployable bundle), `evaluate`, and the label and dataset stages (`label.truth`, `label.heuristic`, `label.merge`, `label.llm`,
`dataset.jsonl`; they read the SnapshotSet and NodeFeaturesSet through the same readers collect and extract write with,
shared from `@gran-prix/labels`). Demo stages (`ts:demo.*`) exercise the runner. The whole chain runs as
`pipelines/dom-v0.json`; see "How to run the E1 gate".

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
   the sha256 of the loaded `.wasm` and only enters the key of `node+wasm` stages; a plugin that runs an
   external binary (`runtime: "rust"`) declares it with `toolDigests()` and its sha256 enters the key
   too (see "Engine stages"). On a hit
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
`gp lineage` walks the sidecars up to the external inputs. Externals (`externals[].path`, relative to
`--root`, which is also `StageContext.root`) are loaded into the store and enter cache keys by id:

* a `.json` file is a JSON artifact;
* any other file is a one-file set;
* **a directory is a file-set artifact of every file below it** (relative paths, sorted, links not
  followed, an empty directory is an error). This is how a real `gp run` starts from an existing
  `Dataset`, `ModelPackage` or `Bundle`: `{ "type": "ModelPackage", "path": "runs/m1/model" }`. `"id"` pins it.

Why directory externals and not a `gp import <type> <dir>` command: the pipeline file stays the single
description of a run (what it reads, by which id), the same code path serves files and directories, and there
is no second step to forget; an import command would only have to write the same artifact into the store.

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

A stage must be a function of its resolved params and input artifacts (plus the wasm binary and any
tool binary it declares in `toolDigests`): the cache key assumes nothing else matters. Demo stages: `emit-json`, `emit-files`, `concat`,
`fail`, `spend`.

## `gp report`

Renders an `EvalReport` (and the optional extras sidecar) as ONE self-contained HTML file by delegating
to `@gran-prix/report` (`renderReport`). The report is validated with the contracts first (exit 1 with
the failing paths), the extras by `parseExtras` (exit 1), a missing argument is exit 2. `-o` defaults to
`<input name>.report.html` in the current directory; `--compare` takes a second report. The artifacts of
a run are plain files: `<data>/artifacts/sha256-<hex>/content.json` (ids are in the stage receipt).

## The `evaluate` stage (`ts:evaluate.intrinsic@1.0.0`)

Scores one split of a `Dataset` with a `ModelPackage` and writes an `EvalReport` **v1.1.0** (intrinsic). Ports:
inputs `model: ModelPackage`, `dataset: Dataset` (the registry contract), an optional `many` `baselines: Bundle`
and an optional `many` `label_baselines: NodeLabelsSet`; outputs `report: EvalReport`, `extras: Bundle` and
`details: Bundle` (micro and macro-by-page tables with CIs, coverage, bootstrap settings). Deterministic given the
inputs and `seed` (`determinism: seeded`, `runtime: node+wasm`, so the wasm hash is in the cache key).

* **The report is self-contained (1.1.0).** It carries `system`, `names`, `notes[]`, `intrinsic.weighting`,
  `intrinsic.bootstrap`, `metric_ci` (model and baselines, "overall" + every stratum), `pr_curve` (sorted, with
  `operating_threshold` = the report threshold and `operating_rule`), `aggregates[]`, `by_tag` (from
  `Dataset.groups[].tags`), `baselines[].coverage`, `comparison[].aggregation`, per-group `group_key` / `n_chars` /
  `f1_by_baseline`, and structured `gates[]` (`name, comparator, threshold, unit, stratum, observed, ci95, metric,
  baseline, aggregation, use_ci_lower`; `passed` is recomputable from `value`). The `extras` output is still written
  for older `@gran-prix/report` builds but is **redundant** with the report and will go away once the renderer reads
  the report alone. Not filled by this stage: `token_reduction` (needs a tokenizer and page text) and `runtime` (G5).
* Unit = dataset row (element); positive = keep. **Weight = characters of own text**: the exact `dataset-row.w` when
  the dataset declares `row_weight` (`buildDataset` of `@gran-prix/labels` writes it from the snapshots' nodes). Datasets without it fall back
  to the characters recovered from the feature `log_own_len` (`round(expm1(x * log1p(5000))`, so at most 5000 per
  element) and say so in `notes`; `params.weight` overrides: `"row"` (requires `w`), `"none"` (1 per element, noted:
  counts are ELEMENTS) or `{ feature, log1p_scale }`.
* `by_stratum`, `overall`, `by_label_source`, `baselines` are MICRO (counts summed over pages) as the
  contract implies; macro-by-page (mean of per-page F1) is in `details`, and is the default statistic of
  `comparison[]` and of the gates (`params.aggregation`). Empty output scores P = F1 = 0.
* CIs: percentile bootstrap over clusters (`group_key`, the domain, by default), seeded, `resamples`
  (default 1000), redrawn within strata. Differences model - baseline use the same resample (paired) and
  both systems on the units the baseline covers (`comparison[].n_groups` counts the pages it covers).
* **Aggregates** (`params.aggregates: [{ name, strata }]`, e.g. `hard`): reported in `aggregates[]` (micro counts,
  macro-by-page and macro-by-stratum F1, `ci95` of the headline F1), compared with every baseline, and usable as a
  gate `stratum`. A gate that pools several strata (`stratum: ["docs", "shop"]`) adds an aggregate named `docs+shop`.
* **Baselines**:
  * a prediction `Bundle`: JSON `{ id, threshold?, predictions: [{ g, u, p }] }` or a file set with
    `predictions.jsonl` (+ `system.json`); `p` is 0/1 or a score (>= threshold, default 0.5);
  * **NodeLabels** (e.g. the `label.heuristic` / Readability output): wire a `NodeLabelsSet` to `label_baselines`
    (edges are type-checked, so a label stage's output goes here), or give NodeLabels documents in a `Bundle` on
    `baselines`. keep = the labels' classes in `params.label_baseline.keep_classes` (default main + support); a unit
    the labeler did not label is **uncovered** (left out of that baseline and of every paired difference, for the model
    as well); pages are matched to the dataset by `snapshot_id` (`manifest.sources[].source_id`, else the `#<hex12>`
    suffix of the group id). The baseline is named by `params.label_baseline.names` (port order) or by the labeler kind.
    `baselines[].coverage` is the share of the weight it covers; a note gives units and weight.
* Gates (`params.gates`): `{ id, name?, metric, comparator, threshold, stratum?, baseline?, aggregation?,
  use_ci_lower? }` become `gates[]` (`value` is the CI bound when `use_ci_lower`) and `extras.gate_details`.
  Thresholds are always params; the stage has none of its own.
* The embedded `provenance` is deterministic on purpose (no run id or clock) so artifact ids are stable;
  the real run provenance is in the receipt and `meta.json`.

```
gp run eval.pipeline.json --data-dir data     # params: seed (required), split, resamples, threshold, weight, aggregates, label_baseline, gates, ...
gp report data/artifacts/sha256-<report>/content.json -o report.html     # --extras <extras> only for older report builds
```

## Data stages: `collect` and `extract` (E1.5)

```
UrlList --collect--> SnapshotSet --extract--> NodeFeaturesSet          FeatureSchema --^
```

Run from the repo root, or pass `--root <repo>` from anywhere (relative paths of the UrlList and of the externals resolve against the run root):

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
| `base_dir` | `ctx.root` | base of relative file paths in the UrlList; optional, a relative value is resolved against the run root (`gp run --root`, else the working directory) |
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

A `.json` external is stored as a JSON artifact; pin it with `"id"` if the pipeline must refuse any other schema. See `tools/cli/test/pipelines/mini-collect-extract.pipeline.json`.
## The `label.llm` stage (`ts:label.llm@1.0.0`, E2.6)

The LLM labeler of `experimento-dom-v0` section 5. Inputs: `snapshots`, `features` and an optional `many` `layers`
(NodeLabelsSets of the heuristic and human labelers, used for routing). Outputs: `labels` (a NodeLabelsSet, one
document per page, `label_source: "llm"`, 3 classes, `labeler.llm` with model, prompt sha256 and the cache keys) and
`report` (a Bundle: plan, routing, tokens, cost). `determinism: "cached-external"`.

* **Prompt:** built at run time from sections 1-4 of the frozen guide (`guide_path`), whose sha256 must equal `guide_sha256`
  (pin the value of `plano/prereg-dom-v0.txt`). The sha256 of the guide and of the final prompt are recorded in every
  label document (`llm_run.guide_sha256`, `labeler.llm.prompt_sha256`).
* **Input to the model:** blocks `n<idx>|tag|ancestor>path|"text"` in document order (id = the element's `data-gp-id`), in
  chunks of `chunk_blocks` (400) with `ctx_blocks` (10) read-only context blocks. Answer: `{"labels":[{"id","c":"M|S|N","u","m"}]}`
  under a JSON schema. Unknown, repeated or missing ids, or malformed JSON: ONE retry with a correction message. Ids still
  missing after it stay unlabeled and are never guessed (`on_missing: "leave_unlabeled"`, the default, as protocol 5.3 says);
  `on_missing: "fail_page"` fails the whole page instead. Malformed JSON, unknown or repeated ids after the retry always fail the
  page, which then writes no labels. `u` (doubt) = confidence 0.5.
* **Routing (`routing`):** `disagreement` (default) sends the units on which the `layers` voters disagree or abstain, plus a
  deterministic 15% control sample of the unanimous ones, and the whole page when there is no voter, a voter's alignment was
  discarded or abstains on more than 30%, or `readerable` is false; units a human layer already settled are never sent.
  `all` sends everything (the audit pages). Pages of `private_categories` (default `logged_in`) never go to the model.
* **Money:** `model` and `prices` (USD per Mtok) are REQUIRED params, nothing is assumed. Every call is preceded by
  `ctx.ledger.reserve(worst case)` and followed by `commit(actual)`; the default cap is $0. When the ledger refuses, the stage
  fails with `LlmBudgetStopError` (`on_budget: "fail"`, default) or returns the finished pages (`"partial"`; use `cache: "off"`
  on the stage in that case, or the stage cache would keep the partial result). Every paid response is cached by
  `llmCacheKey` under `<data dir>/llm-cache/`, so a re-run, even of another pipeline, never pays twice. `dry_run: true` plans
  and logs (pages, routed blocks, chunks, cache hits, estimated tokens and USD) and calls and reserves nothing.
* **Current models (2026-11): sampling, thinking, effort.** The stage validates the combination BEFORE it reads any data, reserves
  anything or calls anything (a dry run included), so a request the API would answer with a 400 never costs a call:
  * `claude-sonnet-5-5`, `claude-opus-5-5` and `claude-haiku-5-5` reject `temperature` (Opus: the parameter itself; Sonnet and Haiku:
    any non-default value, `0` too), so with them **`send_temperature: false` is required** (the default is still `true`, for older
    models, and the stage then fails with a message that names the fix). Reproducibility comes from the response cache (`DESVIOS` #24).
  * `thinking`: `"model-default"` (default) leaves the field out (Opus 5.5 always thinks; Sonnet 5.5 runs adaptive at effort `high`;
    Haiku 5.5 adaptive at `medium`). `"off"` sends the model's no-thinking form: `{"type":"between_tools"}` alone on Sonnet 5.5,
    `{"type":"disabled"}` on Haiku 5.5; it is refused for Opus 5.5 (400 at any effort) and for models outside the validated table
    (`MODEL_RULES` in `packages/labels/src/llm/models.ts`; such models run only plain, without `effort`).
  * `effort`: `low | medium | high`, sent as `output_config.effort`; left out when not set.
  * **Thinking is billed as output and counted in `max_tokens`.** Every call gets `thinking_headroom_tokens` more room (default 8000
    with `model-default`, 0 with `off`; `max_output_tokens` defaults to 16000 + the headroom). The ledger reserve is computed from
    `max_tokens` at the output price, so it covers the worst case of the thinking. A thinking model that spends all of it fails
    the chunk's JSON and the bounded retry pays again: raise the headroom or lower the effort.
  * Both are written to every label document (`llm_run.thinking`, `llm_run.effort`, and into `labeler.params_sha256`) and are part of
    the response-cache key (appended to the output contract, `block_labels_mcn@1+thinking=off+effort=low`; the default request keeps the
    bare id).
  * `prices` takes `cache_write_usd_per_mtok` and `cache_read_usd_per_mtok` besides input/output (defaults 1.25x and 0.1x of the input
    price). The real cost reads `usage.cache_creation_input_tokens` and `cache_read_input_tokens`. The dry run charges the system prompt
    as a cache write once per run and as reads afterwards. `MODEL_RULES[model].prices` holds the 2026-11 tables of the three models
    for the plan script; the stage still takes the prices from the pipeline, never from there.
* **`split_filter`** (`{salt, ranges?, include: ["train"|"val"|"test"]}`): only the pages whose split (`hash-bucket-v1` over the page's
  `group_key`; default ranges 55/70/100 of the protocol) is in `include`. It lets one pipeline send the dev pages by disagreement and
  the test pages with `routing: all` (`pipelines/dom-v0-labeling.json`).
* **Labeling plan of dom-v0:** `pipelines/dom-v0-labeling.json` (dry run: extract, the three extractors of protocol 5.2, `label.llm` with
  `split_filter`: train + val by disagreement, test with `routing: all`) and `node scripts/labeling-plan-dom-v0.mjs --root <repo with data/ and
  IDEIAS/>` (runs it, then writes `data/labeling/plan-v0.json`, `plan-v0.md` and the Studio queues `queues/<task>.json`, format
  `gran-prix.label-queue` 1.0.0, with the cost per model and phase). The script removes `ANTHROPIC_API_KEY` from its environment, runs the
  ledger at cap 0 and refuses a pipeline whose `dry_run` var is not true. Real E2.6 = the same pipeline with `dry_run` false and the chosen
  model/prices in `vars`, `--budget-usd 25`.
* **Key:** only `ANTHROPIC_API_KEY`, read by `AnthropicTransport` when a call is really needed (never for a dry run or a cache
  hit), sent only as the `x-api-key` header, scrubbed from errors, in no artifact, cache entry or ledger line. There is no SDK
  dependency: the transport is `fetch` against `/v1/messages` with `cache_control` on the system prompt and structured output.

```jsonc
{ "id": "llm", "kind": "label", "impl": "ts:label.llm@1.0.0",
  "params": { "model": "<exact model id>", "prices": { "input_usd_per_mtok": 0, "output_usd_per_mtok": 0 },
              "guide_path": "../IDEIAS/plano/guia-de-anotacao.md", "guide_sha256": "55ea2273...c1e5", "dry_run": true },
  "inputs": { "snapshots": { "external": "snapshots" }, "features": { "external": "features" },
              "layers": [{ "stage": "heur", "output": "labels" }] } }
```

## Engine stages (L1)

| impl | ports | notes |
|---|---|---|
| `rust:train.gp-train@1.0.0` | `dataset: Dataset` (+ optional `config: TrainConfig`) -> `model: ModelPackage` | runtime `rust`, `seeded`; params: `seed` (required, overrides the config's), `config` (inline TrainConfig when the input is not connected), `name`, `task_name`, `created_at` |
| `ts:package.bundle@1.0.0` | `model: ModelPackage` -> `bundle: Bundle` | runtime `node+wasm`, `pure`; no params |

**train** runs the `gp-train` binary (ADR-007): build it with `cargo build --release -p gp-train`. It is
found through `$GP_TRAIN_BIN`, else `<$CARGO_TARGET_DIR or ./target>/release/gp-train`; a missing binary
fails the stage with that hint. The **sha256 of the binary is part of the stage's cache key**
(`StagePlugin.toolDigests`, folded in as the reserved input `$tool.gp-train`), so rebuilding the trainer
re-runs `train` and everything downstream and nothing else; the digest is also written to the stage
receipt and to the provenance of its artifacts (`tool_versions.tools`). The runner's cache key,
pipeline spec id and the stage id are passed to `gp-train` (they land in `model.json`'s provenance);
`run_id`, `created_at` and `duration_ms` there are deterministic (cache-key prefix, `params.created_at`
or the epoch, 0), so the package is a pure function of (params, inputs, binary): a fresh data dir or
another run id gives byte-identical artifacts. The real run id lives in the receipt and `meta.json`.
The package must pass `loadModelPackage` (9/9) before the stage accepts it.

**Sample weight** (TrainConfig 1.1.0, optional `sample_weight: "none" | "row"`, default `none`). The config reaches
`gp-train` as written. With `"row"` the loss is the weighted mean `sum(w_i * l_i) / sum(w_i)` over each batch, with `w`
the dataset row's own-text characters (the manifest must declare `row_weight`, otherwise the run fails loudly); a batch
whose weights sum to 0 takes no step, and the validation loss is weighted the same way. Without the field the trainer
is byte-for-byte the one that had no weight. **`ts:train.cv` now fits every grid point with `sample_weight: "row"`
whenever the dataset declares `row_weight`** (the same weight the GBDT trains with, protocol 7; the selection criterion
and tau* already used the same character weights), so MLP results of an earlier build are not comparable: the build of
`gp-train` and the grid digest are in the cache key, so they re-run on their own. A dataset without `row_weight` is fit
unweighted, as before.

**package** verifies the package the same way, then writes the bundle: the package files,
`model.generated.ts` (`@gran-prix/infer-ts`, head taken from `output_spec`), `selftest.mjs` and
`bundle.json` (`model_id`, sha256 and size of every other file, self-test result). The self-test runs
on the real files in a child Node (`--experimental-strip-types`; native on Node >= 22.18) and the
stage fails if golden.json is not reproduced; the same file ships in the bundle:
`cd <bundle> && node selftest.mjs`. The generator's output for a fixed tiny network is part of the
cache key, so a new `infer-ts` re-packages.

A `Dataset` or `ModelPackage` can come from a stage or from an existing directory (a directory external, see "Artifact store");
`test/stages-engine.test.ts` shows a three-stage pipeline over the contracts' dataset fixture and
`test/externals-root.test.ts` starts a `package` stage from a model directory.

## How to run the E1 gate

The gate (`scripts/gate-e1.mjs`) proves that `gp run pipelines/dom-v0.json` is reproducible and that the model it
produces has runtime parity. The pipeline runs the 12 synthetic pages of `fixtures/pages/` through
`collect -> extract -> label.truth (human) + label.heuristic (Readability) -> label.merge -> dataset -> train
(gp-train, a 16-8 MLP) -> package -> evaluate`; it is a pipeline test, not a quality claim.

```
node scripts/gate-e1.mjs            # ~1.5 min; builds what is missing or stale, then runs everything
node scripts/gate-e1.mjs --no-build # only check; fails with the command to run when something is missing
node scripts/gate-e1.mjs --keep     # keep the two data dirs (the path is printed)
```

Needs a Rust toolchain and wasm-pack (the WASM and `gp-train` builds), pnpm with `pnpm install` done, and a cached
Chromium (`GP_CHROMIUM`, or `~/.cache/ms-playwright/chromium-*`). Set `CARGO_TARGET_DIR` to share a target dir; the
trainer binary is copied once at the start so a concurrent `cargo build` cannot change it mid-gate. What it asserts:

1. `gp validate pipelines/dom-v0.json`;
2. `gp run` twice into two fresh data dirs, with run ids `gate-a` and `gate-b`: **every output artifact id and every
   cache key of every stage is identical** (the table at the end prints them, `==` per line);
3. a second run in the same data dir is a **100% cache hit**;
   (the dataset must declare `row_weight: own_text_chars`: rows carry `w`, the characters of their own text, and evaluate
   weighs by it exactly; the report must hold the Readability baseline, wired from `label_heuristic` to `label_baselines`);
4. parity of the produced model: `gp model check` 9/9 with `--runtime ts` and with `--runtime wasm`; the self-test of
   the package bundle (`node selftest.mjs`, the generated TypeScript runtime) passes; and the Rust runtime
   (`gp-train eval --with-scores`, which loads the package and verifies digests and `model_id`) reproduces every case of
   `golden.json` on the real dataset rows;
5. `gp report` renders the evaluate output to HTML. The report is a post-step, not a stage: the pipeline has no `report`
   kind, `gp report <evaluate.report> [--extras <evaluate.extras>]` is the command.

It prints a PASS/FAIL table and exits 1 on FAIL (2 on a setup problem). `tools/cli/test/dom-v0.test.ts` checks the
pipeline file and the contracts example against the real stages without running them.

**The split.** With 12 pages and `group = file stem` every group is a single page, and a hash split of 12 groups can leave a
split empty. The pipeline therefore fixes the split with `split.overrides`: train = the six `*-1` pages + `landing-2`
(7), val = `article-2`, `docs-2` (2), test = `forum-2`, `product-2`, `spa-2` (3, three strata). Every page carries human
truth, so the test split (human labels only, ADR-006) keeps all its rows. `split.seed` is still required: it is the salt
of the hash bucket for any group without an override.

## Tests

```
node scripts/build-wasm.mjs --target both --web-out packages/wasm/dist/web --node-out packages/wasm/dist/node
pnpm --filter @gran-prix/cli test        # runs against the sibling sources; needs only the WASM build
pnpm --filter @gran-prix/cli... build    # contracts, infer-ts, model, report, cli (typecheck needs the first four built)
pnpm --filter @gran-prix/cli test        # runs against the sibling sources; needs the WASM build and a cached Chromium (the collect tests)
pnpm --filter @gran-prix/cli... build    # contracts, infer-ts, model, features, cli (typecheck needs the first four built)
```
