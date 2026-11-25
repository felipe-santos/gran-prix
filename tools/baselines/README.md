# Baselines of the DOM experiment (E2.7)

Protocol: `plano/experimento-dom-v0.md` (frozen), section 7 (baselines B0-B6), 2.4 (U2) and 8 (G0).

| What | Where |
|---|---|
| `label.trafilatura`, `label.defuddle`, `label.router` stages | `tools/cli/src/stages/baselines/` (registered in `tools/cli/src/stages/index.ts`) |
| Labels from any extractor's text (alignment back to element ids) | `packages/labels/src/extraction.ts` (`labelPageExtraction`) |
| Trafilatura Python sidecar | `python/traf_sidecar.py` |
| U2 sanity check on WCXB | `u2/run_u2.py` |
| Offline GBDT (G0), never shipped | `gbdt/gbdt.py` |
| Python unit tests | `test/` (also run by `tools/cli/test/baselines-python.test.ts`) |

## Setup (never system-wide)

Python packages go in a gitignored directory inside the repo, pinned in `requirements.txt`:

```bash
pip install --target tools/baselines/.pylibs -r tools/baselines/requirements.txt
```

The stages find the sidecar through `GP_PYTHON` (default `python3`) and `GP_BASELINES_PYLIBS` (default
`tools/baselines/.pylibs`). Defuddle is an npm dependency of `tools/cli` (pinned `0.19.13`). Without the Python packages
the Trafilatura/router tests are skipped with a warning; everything else runs.

## Label stages

All three have the ports of `label.heuristic` (`snapshots` + `features` in, `labels` out, one NodeLabels per page), write
`kind: "heuristic"` labels (`source: "heuristic"`; the h1 rule is `source: "rule"`) and record the tool, version and options
in the document (`extraction`) and the alignment coverage in `alignment`. The extractor gets the **flattened HTML** of the
snapshot; its **text** is aligned back to element ids by the DP of `@gran-prix/labels` (the one Readability uses); a unit
is main when its text was returned, noise otherwise (the binary projection keep = main + support is unaffected).

Shared params (all optional): `confidence` (0.7), `min_coverage` (0.9), `fuzzy` (false), `h1_title` (true).

* **`min_coverage`**: alignment coverage under which a page's labels are discarded (an abstention, for the labeling
  workflow of protocol 5.2). **For scoring a baseline set `min_coverage: 0`**: protocol 7 says a page with low
  coverage is scored anyway and the coverage reported; an empty output then drops every unit (F1 = 0, never 1).
* The labelers are all `kind: "heuristic"`: when wiring several into evaluate's `label_baselines`, name them with
  `evaluate` `params.label_baseline.names` (see `test/baselines-pipeline.test.ts`).

### `ts:label.trafilatura@1.0.0`
`mode`: `precision` | `default` | `recall` (default **recall**, protocol 5.2; B2 evaluates the three in dev),
`include_tables` (true), `include_comments` (true), `no_fallback` (false). Labeler id `trafilatura@<version>:<mode>`.
`toolDigests` puts the Trafilatura version and the sidecar source in the cache key.

### `ts:label.defuddle@1.0.0`
`switches`: Defuddle booleans to override (`removeExactSelectors`, `removePartialSelectors`, `removeHiddenElements`,
`removeLowScoring`, `removeSmallImages`, `standardize`, `removeContentPatterns`); `{}` is the default run and
`{"removeLowScoring": false}` is the protocol's "1 variant". `useAsync` is forced to `false`: Defuddle's default lets
async extractors call third-party APIs, and labels must not depend on the web. Defuddle's output drops `data-gp-id`
(attribute whitelist), so, unlike Readability, there is no "ids" path: text alignment only (see deviations).

### `ts:label.router@1.0.0`
One extractor per page, by page type (B4).
* `type_from`: `predicted` (default; JSON-LD `@type`, then `og:type`, then URL rules, first signal that decides wins,
  `router-rules.ts`) or `category` (the snapshot's corpus category: the oracle type of B4).
* `table`: extractor per type, `{ "forum": { "extractor": "defuddle" } }`; unlisted types keep the **a priori default**
  (`DEFAULT_ROUTER_TABLE`: Trafilatura everywhere, `recall` for forum/product/landing/spa, `default` for article/docs/unknown;
  chosen from the WCXB's published per-type dev table and the documented meaning of the modes, never from our data). The
  oracle router of B4 passes the table chosen **in dev**; never tune it on test.
* `fallback` (true): when the pick is unusable (no output, or under 90% of its text explained by the page) the router
  tries Trafilatura(default), Defuddle, Readability in that fixed order and keeps the first usable one; none usable = the
  pick stands. The decision is recorded per page: `router: { type, type_signal, evidence, chosen, used, tried }`.
* The rules are fixed in code. Changing them is a new `impl` version and a recorded deviation.

## U2: baseline sanity check on WCXB

```bash
pip install --target tools/baselines/.pylibs-ref -r tools/baselines/requirements-ref.txt   # only for --reference
PYTHONPATH=tools/baselines/.pylibs python3 tools/baselines/u2/run_u2.py --data-dir data/wcxb --variants --reference
```
Samples 150 WCXB **dev** pages (ascending `sha256("gp-dom-v0|20261125|" + url)`, first 150), downloads **only** their ground
truth and cached HTML (the URL of every dev page comes from the first bytes of its ground-truth file; ~40 MB in total),
runs Readability.js (`@mozilla/readability` 0.6.0 on jsdom, default options) and Trafilatura (2.4.0, defaults) on the cached
HTML, scores the bag-of-words F1 of section 6.4 (bootstrap CI: B = 10 000, `default_rng(20261125)`) and writes
`data/wcxb/u2-report.json`. Results of the run recorded with this work:

| System | Expected | Range | Observed (mean, 95% CI) | Verdict |
|---|---|---|---|---|
| Trafilatura 2.4.0, default | 0.79 +- 0.04 | 0.75-0.83 | 0.853 [0.818, 0.885] | above range |
| Readability.js 0.6.0, default | 0.67 +- 0.07 | 0.60-0.74 | 0.776 [0.726, 0.822] | above range (CI overlaps) |
| *reference* Trafilatura 2.0.0, default | | 0.75-0.83 | 0.799 [0.753, 0.842] | inside |
| *reference* readability-lxml 0.9 | | 0.60-0.74 | 0.702 [0.643, 0.758] | inside |

Diagnosis: the harness, sampling and metric are right (the WCXB's own Trafilatura 2.0.0 row, F1 0.791 / P 0.852 / R 0.793,
is reproduced: 0.799 / 0.848 / 0.832); the miss is the **tool version** (2.4.0 is +0.054 F1 over 2.0.0 on this sample) and, for
Readability, the **implementation** (the WCXB does not say which; the Python port lands inside the range, the JS original,
which section 7 mandates for B1, does not: 0.4.1 and 0.6.0 both ~0.78; `charThreshold` 0/250/500 make no difference).
Neither is a misconfiguration to "fix", both baselines are STRONGER than the published ones, which is the safe side for a
claim of the form "the model beats the best baseline". Decision left to the coordinator/owner: keep 2.4.0 and Readability.js
(recommended), or pin 2.0.0 in `requirements.txt` (one line) to land inside the stated range.

WCXB: Foley, M. (2026), *WCXB: A Multi-Type Web Content Extraction Benchmark*, CC-BY-4.0,
doi 10.5281/zenodo.19316874, https://huggingface.co/datasets/murrough-foley/web-content-extraction-benchmark (pinned
revision in `u2/wcxb.py`). Never commit the data: it lives in `data/wcxb/` (gitignored). WCXB is a draft by an LLM with one
human review, with no kappa: it is a sanity check, never a gold or a gate.

## GBDT (B5, gate G0)

```bash
PYTHONPATH=tools/baselines/.pylibs python3 tools/baselines/gbdt/gbdt.py --dataset <Dataset dir> --out <dir> [--seed 1] [--emit test]
```
Reads the Dataset (manifest + `train/val/test.jsonl`), same features, rows and weights (`w`) as the MLP, trains
scikit-learn `HistGradientBoostingClassifier` (the protocol's choice; deterministic for a fixed seed with early stopping off,
native `sample_weight`, no native wheel beyond scikit-learn) and writes, under `--out`:

* `bundle-dev-oof/`: nested out-of-fold predictions of dev (train + val), for G0 (dev OOF);
* `bundle-<split>/` for each `--emit` split (default `test`): the frozen model (selected config refit on all dev), scored once;
* `gbdt-report.json`: configurations and scores, selected config, tau*, folds, versions, per-stratum dev OOF F1, hashes.

Each bundle is `predictions.jsonl` (`{g, u, p}`) + `system.json` (`{id: "gbdt", threshold: tau*}`), the Bundle that evaluate's
`baselines` port takes. Rules: tuning on dev only; folds grouped by domain (`group_key`, k = manifest `split.kfold.k`, else
5; deterministic greedy balance, no randomness); at most 12 configurations (`CONFIGS`, fixed in the file); selection by the
dev OOF macro-per-page F1 at tau*; tau* = largest threshold with character-weighted recall >= 0.95 on the nested dev OOF;
nested tuning (the 12 configurations are re-tuned inside every outer fold on the other folds only; `--no-nested` reuses the
all-dev choice, faster and slightly optimistic).

## Tests

```bash
pnpm --filter @gran-prix/cli test -- baselines      # TS: router table, stages, mini pipeline, Python suite
cd tools/baselines && PYTHONPATH=.pylibs python3 -m unittest discover -s test -p 'test_*.py'
```
