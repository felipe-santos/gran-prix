# @gran-prix/report (`gp report`)

Renders an `EvalReport` (contract `gran-prix.eval-report`) as ONE self-contained HTML file: inline CSS,
inline SVG charts, no scripts, fonts, images or network references. It opens offline from disk and can be
attached to a decision record. The output is a pure function of the input (no clock, no randomness).

```bash
pnpm --filter @gran-prix/report build        # also builds @gran-prix/contracts
node packages/report/bin/gp-report.mjs report.json -o report.html
node packages/report/bin/gp-report.mjs report.json --compare other.json --extras extras.json
```

The CLI validates with `@gran-prix/contracts` first (shape, invariants, `report_id`) and exits `1` with the
failing field paths on invalid input, `2` on a usage error.

```ts
import { renderReport } from "@gran-prix/report";
const html = renderReport(report, { extras, compare });
```

## What is shown, in order

1. Header: model, dataset and report ids, created_at, provenance.
2. Gates (omitted when the report has none): rule/threshold, observed value (with CI when given), PASS/FAIL as text plus icon.
3. Metrics by stratum: overall tiles, F1/precision/recall dot-and-whisker panels (model against every baseline),
   a table, model-minus-baseline F1 with the report's group-bootstrap CI, by label source, weakest groups.
4. Confusion matrices (overall and per stratum; counts and row-normalised), derived from tp/fp/tn/fn.
5. PR curve with the operating threshold marked and baselines as points, plus a reliability diagram.
6. Token reduction for D1 (raw HTML) and D2 (whole-page markdown).
7. Notes and threats. In `downstream` reports: arms and paired deltas. With `--compare`: per-stratum deltas and gate states,
   blocked when the two `dataset_id`s differ.

Anything the data does not contain is omitted or replaced by a single "not in this report" line.

## Report extras (sidecar) and proposed contract changes

EvalReport v1.0.0 cannot carry everything the go/no-go protocol (A3 section 6.5) needs. Instead of inventing numbers,
the renderer reads the missing pieces from an optional sidecar (`--extras`, validated, see `src/extras.ts`;
a sample is `test/fixtures/rich-extras.json`). Proposed additions to the contract (a MINOR bump):

| Gap in v1.0.0 | Why it matters | Sidecar field today |
|---|---|---|
| No CI on per-stratum P/R/F1 (only on `comparison[].ci95`) | G1/G2 are decided on CIs; the stratum chart cannot show whiskers | `metric_ci` |
| No PR-curve points (only `pr_auc`) | The curve with the operating threshold | `pr_curve.points` |
| `token_stats` has one unlabelled ratio | G4 needs D1 and D2 and the median/IQR (A3 M5) | `token_reduction.d1/d2` |
| `gates[]` has `id`, `rule` (free text), `value`, `passed` only | Name, machine-readable threshold, comparator and the CI of the observed value | `gate_details` |
| No model/dataset names, no notes or threats | Readable header; threats to validity travel with the number | `names`, `notes` |
| `by_stratum` has no per-baseline `n_groups` | Group counts only shown for the model | none |

The sidecar is not part of `report_id`, so it can be added or corrected without changing the report's identity.

## Development

```bash
pnpm --filter @gran-prix/report test      # builds, then vitest (render, golden, CLI)
pnpm --filter @gran-prix/report example   # regenerates examples/example-report.html
node packages/report/scripts/make-rich-fixture.mjs   # regenerates the synthetic fixtures
```

`examples/example-report.html` is rendered from the SYNTHETIC fixture `test/fixtures/rich-eval-report.json`
(every number is invented to exercise every section) and is compared byte for byte by the tests, together with
`test/golden/valid-eval-report.html`. Update goldens deliberately: `pnpm --filter @gran-prix/report exec vitest run -u`.
