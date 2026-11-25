# @gran-prix/contracts

Versioned data contracts of the Gran-Prix pipeline (E1.1) and the identity /
provenance helpers that give every artifact a content-addressed id (E1.3).

* **One source of truth**: each contract is a [TypeBox](https://github.com/sinclairzx81/typebox)
  definition in `src/`. It yields the static TypeScript type and the JSON Schema
  (draft-07) from the same code. [Ajv](https://ajv.js.org) (strict mode) validates at runtime.
* **Cross-language**: `schemas/<contract>.schema.json` are generated, committed, and
  self-contained (every `$ref` is `#/$defs/...` inside the same file). The Rust side
  (`gp-train`) tests against these files. `pnpm check:schemas` fails when a committed
  schema is stale or was edited by hand.
* **Generic where cheap**: Dataset, TrainConfig, ModelPackage, EvalReport, PipelineSpec
  speak in `unit` (one decision row), `group` (what a split must not cut, e.g. a page) and
  `stratum` (reporting category). Only PageSnapshot, FeatureSchema details, NodeFeatures,
  NodeLabels unit ids and ContentTree are DOM-specific.

```
pnpm install
pnpm build            # tsc + emit schemas/*.schema.json
pnpm test             # vitest
pnpm check:schemas    # fails if schemas/ differs from the TypeBox definitions
pnpm fixtures:regen   # only when a contract changes: rewrites fixtures/ (review the diff)
```

## Contracts

| Contract (`format`) | What it is |
|---|---|
| `page-snapshot` | Immutable record of a rendered page: composed-tree pre-order element table (style, rect, text lengths, attrs, `disclosure`), `text_units`, `probe` (id scheme), page `og_type` / `jsonld_types`, flattened `rendered.html.gz` ref. `capture` (incl. `settle`, `network`) is outside the id. DOM-specific. |
| `feature-schema` | Hash-identified, immutable list of named features with stable indices, static transforms, optional `context` features (parent / prev / next), ranges (= OOD clip bounds), prefilter rules. Fitted normalization is NOT here (it lives in the model). |
| `node-features` | Feature matrix of one snapshot under one schema; every value is a float32. DOM-specific. |
| `node-labels` | Labels of one snapshot from one labeler or a `merge`: `label_source`, `confidence` (= P(label correct)), 3-class space (main / support / noise, ADR-006). `projectToBinary` collapses to keep/drop. |
| `dataset-manifest` + `dataset-row` | `manifest.json` + `train/val/test.jsonl`. Split = hash bucket of `group_key` (domain, ADR-006), never a PRNG; overrides are recorded; groups carry `tags` (v1.1: `logged_in`, `lang:pt`, ...) and `stats.by_tag`. A JSONL line is a `dataset-row` (v1.1: optional `w` = own-text chars, the evaluation weight). |
| `network-def` | The Rust core's `NetworkDef` JSON, mirrored strictly (`additionalProperties: false`, because serde ignores unknown fields silently). |
| `train-config` | Recipe: mandatory `seed`, network (def or MLP template), loss, Adam lr, data policy, normalization, early stopping, threshold strategy, engine (`wasm-node` / `gp-train`). |
| `model-package` | `model.json` of ADR-003: `feature_spec`, `output_spec` (activation, labels, calibration), `thresholds` (accept / escalate / margin), `digest`, `requires`, `metrics`, `provenance`. Sits beside `network_def.json`, `weights.f32le`, `golden.json`. |
| `golden` | `golden.json`: input / raw / score triples, tolerance, bound to the weights hash. Parity tests for TS, WASM and Rust. |
| `eval-report` | Per-stratum P/R/F1 (+ CI95), baselines, by-label-source, group-bootstrap CIs and `bootstrap` metadata, PR curve + operating threshold, D1/D2 token reduction (median / IQR, per stratum), G5 `runtime`, QA arms with evidence retention, structured gates (`comparator`, `threshold`, `unit`, `ci95`, `use_ci_lower`), `system.kind`, names, notes / threats. |
| `label-agreement` | (v1.1, C0) Cohen's kappa audit between labelers: pairs x strata x {binary, 3-class} x {elements, chars}, confusion matrices (kappa is recomputed from them), bootstrap CIs, test-retest, gates. |
| `qa-task-set` | (v1.1, C10) The frozen questions of the downstream QA study: question, short answer + variants, evidence units + literal quote (never `noise`), kind, validation, rejection rate. |
| `content-tree` | Pruned document: block tree with inline runs and `src` back-references to snapshot units. DOM-specific. |
| `stage-kind-spec` | Registry entry of a stage implementation: typed ports (artifact types map to contracts), `params_schema`, runtime, determinism, gates. v1.1 adds the `demo` stage kind (runner demos stop borrowing real kinds). |
| `pipeline-spec` | Declarative DAG: stages, `{stage, output}` / `{external}` refs, variables, editor `layout` (outside the id). |

Normative details not visible in the schemas (those marked v1.1 are normative from contracts v1.1, ADR-009):

* `thresholds`: `score >= accept` accepts; `escalate <= score < accept` (or a top-1/top-2 gap below `margin`) escalates to a stronger judge; `score < escalate` rejects. `escalate <= accept` is enforced.
* z-score: `x' = (x - mean) / (std + eps)`, applied to the extractor output before the network. `golden.input` is the extractor output (before normalization), so a golden run covers normalization too.
* `output_spec.activation = "sigmoid"` means one logit, `labels = [negative, positive]`; calibration (`platt`) acts on the logit.
* (v1.1) **PageSnapshot ids and traversal.** The element table is the **composed-tree pre-order**:
  `visit(el) -> children of el's OPEN shadow root, in order -> el's light-DOM children, in order`. Element id = pre-order index `k`
  (`nodes[k].idx === k`, DOM attribute `data-gp-id="n<k>"`); the parent of a node in a shadow root is the shadow host. Not entered:
  iframe documents (the `<iframe>` itself is a node), closed shadow roots, `<template>` content, text nodes directly in a shadow root.
  Ids are valid for ONE snapshot. `probe.id_scheme = "gp-composed-preorder/1"` names this rule and is part of the snapshot id.
  A **text unit** is a non-blank light-DOM text node, id `n<owner>#t<child index among the owner's childNodes>` (e.g. `n9#t2`);
  `text_units` lists them in composed document order, so the child index strictly increases per owner.
* (v1.1) **The `html` FileRef** of a snapshot is the *flattened* rendered HTML: stored gzip (`content_encoding: "gzip"`), open shadow roots inlined,
  `data-gp-id` attributes kept (the join key to `nodes`), `<script>` elements kept but **emptied** (not removed: they carry ids). Not the HTML the server sent.
* (v1.1) **FileRef.** `sha256` and `bytes` describe the DECODED content; `content_encoding` (optional, e.g. `gzip`) only says how it is stored, so zlib builds never change an id.
* (v1.1) **Capture quality.** `capture.flags` (`http-error`, `error-page`, `captcha`, `paywall`, `tiny-dom`) and `capture.settle` (`reason`, `shadow_roots`, `tracked_from_start`, `late_unstamped`; no volatile timings) live outside the snapshot id.
* (v1.1) **Disclosure.** `nodes[i].flags.disclosure = true` marks an element inside a collapsed disclosure (closed `<details>`,
  `aria-expanded=false` region, inactive `role=tabpanel`): not rendered, but part of the labelable universe U (labeling guide 2.3).
* (v1.1) **Attributes.** `attrs.id`, `role`, `href`, `type` are the attribute values as written (href is not resolved); `type` of
  input / button / select / textarea is the effective property (implicit default when absent). `own_text` is cut at `probe.own_text_cap` UTF-16 units.
* (v1.1) **Static transforms** apply to the raw feature value x: `none` x; `log1p` **log1p(x) / log1p(scale)**; `clip` min(hi, max(lo, x)); `div` x / by;
  then NaN -> 0, clip to `range` (counted in `sanitized`), float32.
* (v1.1) **Prefilter.** A `display_none` rule is a **subtree** rule (the node and everything below it is not rendered); `tag`, `visibility_hidden`,
  `zero_rect` drop only the matching node. A prefiltered node is not a row and not a sibling. `NodeFeatures.unit_ids` are exactly the
  non-prefiltered nodes (`n_nodes_total - sum(prefiltered)` rows); each prefiltered node is counted once, under the first dropping rule.
* (v1.1) **Context features** (`FeatureDef.context = { rel: parent | prev | next, source }`) copy the finished value of the non-context feature `source`
  at the parent / previous / next non-prefiltered sibling; `default` when there is none.
* (v1.1) **Gates.** `value <comparator> threshold` is the passing condition; with `use_ci_lower`, `value` is the CI bound facing the threshold
  (`ci95[0]` for `>=` / `>`, `ci95[1]` for `<=` / `<`). The validator recomputes `passed`. v1.0 gates (`id`, `rule`, `value`, `passed`) stay valid.
* (v1.1) **Embedded provenance.** A stage inside a pipeline cannot know its run, so an embedded `provenance` may be a deterministic stand-in
  (`placeholder: true`, e.g. `run_id: "deterministic"`); the runner receipt keyed by the artifact id is authoritative. Provenance is outside
  every content id, so replacing the placeholder never changes an id. `provenance` stays required (making it optional would break v1.0 readers).
* (v1.1) **Weights.** `Dataset.row_weight = "own_text_chars"` means every row carries `w`, the unit's own-text length in Unicode code points
  (NFC, whitespace collapsed): the weight of the char-weighted metrics. `EvalReport.intrinsic.weighting` = `{ unit, positive_class?, weight_source? }` says what `n / tp / fp / tn / fn` count; `intrinsic.bootstrap`
  (resamples, seed, cluster_by, method, stratified) is the resampling behind every CI; `comparison[].aggregation` / `gates[].aggregation` say micro vs macro_page vs macro_stratum.
* Floats in JSON artifacts are float32 values (`Math.fround`) printed with their exact double expansion; readers must not re-interpret them.

## Validation

```ts
import { validate, assertValid, pipelineRegistryIssues } from "@gran-prix/contracts";

const r = validate("feature-schema", doc);   // { ok: true, value } | { ok: false, issues }
// issue: { code: "schema" | "version" | "invariant" | "id-mismatch" | "lint", contract, path, message }
```

`validate` runs, and stops at the first stage that fails: (1) `format` / `format_version`
(unknown MAJOR refused), (2) JSON Schema, (3) invariants JSON Schema cannot express:
`features[i].index === i`, unique names, `idx === position`, `parent < idx`, id recomputation,
dataset leakage (no `group_key` in two splits) and bucket recomputation, weights layout
contiguity, `input_dim === feature_spec.dim`, DAG acyclicity, and so on. It never repairs a
document. `pipelineRegistryIssues(spec, kinds)` adds the registry-dependent checks (port types,
`params_schema`, required seed). Loading files, `networkDefJson()` round-trip and golden
execution are the ModelPackage loader's job (E1.2), not this package's.

## ID rules (E1.3)

* **Canonical JSON** = RFC 8785 (JCS): keys sorted by UTF-16 code units, no whitespace, ECMAScript
  number formatting (`-0` -> `0`), JSON string escaping. Strictness beyond the RFC: `NaN` / `Infinity`,
  lone surrogates, `undefined` in arrays, non-plain objects (Date, Map, class instances) and cycles
  throw instead of being coerced. Object members whose value is `undefined` are omitted (equal to
  absent). One implementation (`canonicalJson`) computes every hash; Rust never hashes JSON.
* **`artifactId(v)`** = `"sha256:" + hex(sha256(canonicalJson(v)))`. `sha256Of(bytes)` hashes raw
  bytes (weights are never hashed through JSON).
* **`contractId(contract, doc)`** = `artifactId(doc minus its id field minus provenance-like fields)`:

  | Contract | Excluded from the id |
  |---|---|
  | page-snapshot | `snapshot_id`, `capture` |
  | feature-schema | `schema_id`, `description`, every `features[].doc` |
  | node-features / node-labels / train-config | own id field |
  | dataset-manifest | `dataset_id`, `provenance` |
  | eval-report / label-agreement / qa-task-set | own id field, `provenance` |
  | pipeline-spec | `layout` (editor positions) |

  `format` and `format_version` ARE hashed (no cross-type collisions; writers must emit the
  smallest version that describes the artifact).
* **`modelId(model.json)`** (ADR-003, identity = behavior) = `artifactId({ v: "gran-prix.model-id/1",
  digest: { network_def, weights }, task, feature_spec, output_spec, thresholds, requires })`.
  Not in the id: `name`, `description`, `metrics`, `provenance`, `digest.golden`, file paths and sizes,
  `format_version`. `digest.network_def` is the hash of the canonical JSON of the parsed
  `network_def.json` (whitespace-proof); `digest.weights` / `digest.golden` hash raw file bytes.
* **`stageCacheKey({ impl, params, inputIds, wasmSha?, toolSha?, kind?, nodeMajor? })`** =
  `sha256(canonical({ v, kind?, impl, params, inputs, env: { wasm_sha256?, node_major?, tool_sha256? } }))`.
  `toolSha` (v1.1) is the hash of the native binary of a `runtime: "rust"` stage (e.g. `gp-train`); recorded as `tool_versions.tool_sha256` in provenance.
  Depends on the exact impl version, resolved params, input artifact **ids** (a many-port's order
  matters) and, only when given, the wasm binary. Independent of run id, clock, host, port order,
  editor layout. `llmCacheKey` does the same for cached LLM labeling calls.
* **Provenance** (`Provenance`: producer stage, params hash, cache key, input ids, tool versions,
  wasm sha, timestamps) is a sidecar / embedded field, never inside an id.
* **Split**: `groupBucket(salt, group_key) = u32_be(sha256(salt + "\0" + group_key)[0..4]) % 100`;
  ranges are half-open `[lo, hi)`; `assignSplit` applies manual `overrides` last.

## Versioning policy

Every contract has `format` + `format_version` (semver of the **contract**, current value in
`CONTRACTS[i].version` and in each schema's `x-gran-prix`). The content id is the identity;
the semver is the language.

| Change | Bump |
|---|---|
| Add an **optional** field an old reader can ignore without changing meaning | MINOR |
| Add an enum value an old reader treats with a safe default | MINOR (otherwise MAJOR) |
| Clarify docs, relax a limit | PATCH |
| Remove / rename a field; change type, unit or semantics; optional -> required; change order or meaning of an index; change canonicalization, a hash rule, the `model_id` / split formula; tighten an enum or a limit | **MAJOR** |
| Any change to a `FeatureDef` (value, transform, order, add, remove) | new `schema_id` (models bind to the exact id; there is no "compatible schema") |
| New `LayerDef` variant in the core | MINOR of model-package (`requires.layer_types`); new field on an existing variant is MAJOR or forbidden |

Clarifications made by contracts v1.1 (ADR-009): (a) a **new value of a closed enum** (`StageKind` `demo`, `comparison.metric`) is a MINOR when the
writer declares the new `format_version` for every document that uses it: an older reader then *refuses* the document at that field
(never misreads it), which is the intended failure; (b) **new invariants apply only to new fields** (an invariant that rejects a document
the previous version accepted is a MAJOR change in disguise); (c) every contract of a release is listed in `CONTRACT_SET_VERSION`
(`1.1.0` today) while each keeps its own `format_version`.

Reader rules: unknown **MAJOR** -> refuse (`code: "version"`); newer MINOR / PATCH of a known MAJOR
-> accept and ignore unknown fields, except those listed in `model-package.requires.extensions`
(unknown there -> refuse). Schemas are therefore open (`additionalProperties` allowed), except
`network-def`, which is closed on purpose. A reader never "fixes" a document.

When a contract changes: edit the TypeBox definition, bump its version per the table, run
`pnpm build`, run `pnpm fixtures:regen` for a MAJOR (fixtures of a shipped version are frozen:
keep the old ones next to the new ones), update this README, commit schemas + fixtures.

## Fixtures

`fixtures/valid/` holds one valid example per contract (plus a complete model package and dataset
directory whose digests are real); `fixtures/invalid/` holds one document per defect, with the
expected `{code, path, message}` in `expectations.json`. Everything is synthetic (no real page text). `fixtures/v1.0/` is a byte-for-byte copy of the v1.0 `valid/`, `invalid/` and `schemas/`:
frozen, never regenerated, read by `test/compat-v1.0.test.ts` (every v1.0 document still validates, every v1.0 invalid one still fails, the
current schemas are a structural superset of the frozen ones, and the v1.1 documents validate against the frozen v1.0 schemas except at
the documented enum widenings). Valid fixtures declare the smallest `format_version` that describes them (`pipeline-spec.json` stays 1.0.0).
The tests check that each valid fixture passes, each invalid one fails with its expected path, and
that the committed files equal the builders in `src/tools/fixtures/`.

## Differences from the A1 design notes

See the delivery report of E1.1 / E1.3 for the full list; in short: `ModelPackage` follows ADR-003
(`feature_spec` / `output_spec` / `thresholds` / `digest`, no embedded `feature_schema.json`);
dataset groups use `stratum` and `group_key` (generic) instead of `category` / `url_key`; the binary
label space is `["drop", "keep"]`; `ContentTree` media nodes use `url` (A1's `src` clashed with the
back-reference field); `FeatureDef.doc` is excluded from `schema_id`.
