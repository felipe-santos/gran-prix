# @gran-prix/report (`gp report`)

Renders an `EvalReport` (contract `gran-prix.eval-report`) as ONE self-contained HTML file: inline CSS,
inline SVG charts, no scripts, fonts, images or network references. It opens offline from disk and can be
attached to a decision record. The output is a pure function of the input (no clock, no randomness).

```bash
pnpm --filter @gran-prix/report build        # also builds @gran-prix/contracts
node packages/report/bin/gp-report.mjs report.json -o report.html
node packages/report/bin/gp-report.mjs report.json --compare other.json
node packages/report/bin/gp-report.mjs old-v1.0-report.json --extras extras.json   # sidecar: v1.0 reports only
```

The CLI validates with `@gran-prix/contracts` first (shape, invariants, `report_id`) and exits `1` with the
failing field paths on invalid input, `2` on a usage error.

```ts
import { renderReport } from "@gran-prix/report";
const html = renderReport(report, { extras, compare });
```

## What is shown, in order

1. Title and a compact identity block: model and dataset names, `system.kind`, short ids (the full hashes are in Provenance).
2. **Gates** (omitted when the report has none), right after the identity block: one card per gate with PASS/FAIL as text plus an icon,
   the observed value and the threshold with their **unit** (`112.4 ms ≤ 150 ms`, `1.8× ≥ 2×`, `−2.6 pp ≥ −5 pp`, `+0.052 F1 ≥ +0.050 F1`).
   A gate decided on a CI bound (`use_ci_lower`) shows the CI, marks the bound that decided it and gives the point estimate.
3. Metrics by stratum: a methods line (weighting unit, bootstrap), overall tiles, F1/precision/recall dot-and-whisker panels
   (model against every baseline, with `coverage`), a table, aggregates (micro and macro), model-minus-baseline per metric with its
   aggregation and the report's group-bootstrap CI, by tag, by label source, weakest groups.
4. Confusion matrices (overall and per stratum; counts and row-normalised), derived from tp/fp/tn/fn.
5. PR curve with the operating threshold (and the rule that chose it) marked and baselines as points, plus a reliability diagram.
6. Token reduction for D1 (raw HTML) and D2 (whole-page markdown): median, IQR and the "×" factor, pooled totals, by stratum.
7. Runtime (G5): p95, model size, CPU throttle, environment.
8. Downstream QA (arms, evidence retention, paired deltas), with `--compare` the per-stratum deltas and gate states
   (blocked when the two `dataset_id`s differ), then notes and threats.
9. **Provenance**, last, in a `<details>` that is closed by default: ids, run, inputs and tool hashes.

Anything the data does not contain is omitted or replaced by a single "not in this report" line.

## EvalReport v1.1 is read natively; the extras sidecar is a v1.0 fallback

EvalReport 1.1.0 carries what used to travel in a separate sidecar: `metric_ci`, `pr_curve`, `token_reduction`, structured `gates[]`
(`name`, `comparator`, `threshold`, `unit`, `observed`, `ci95`, `use_ci_lower`, ...), `names`, `notes`, plus `system`, `aggregates`,
`intrinsic.weighting` / `bootstrap`, `baselines[].coverage`, `comparison[].aggregation`, `runtime` and `by_tag`.
The renderer reads every one of them from the report. A v1.0 report cannot carry them, so for those the optional sidecar
(`--extras`, validated, see `src/extras.ts`; a sample is `test/fixtures/rich-extras.json`) still fills the gaps.

**The report always wins.** When both have a field, the report's is shown and the sidecar's is ignored, field by field (a report's `metric_ci`
is never completed with the sidecar's). For gates, the sidecar's `name` / `ci95` / `threshold` text are used only when the gate itself lacks them.
The sidecar is not part of `report_id`.

## Development

```bash
pnpm --filter @gran-prix/report test      # builds, then vitest (render, golden, CLI)
pnpm --filter @gran-prix/report example   # regenerates examples/example-report.html
node packages/report/scripts/make-rich-fixture.mjs   # regenerates the synthetic fixtures (v1.0 + sidecar, and native v1.1)
```

`examples/example-report.html` is rendered from the SYNTHETIC v1.1 fixture `test/fixtures/rich-eval-report-v11.json`, with no sidecar
(every number is invented to exercise every section), and is compared byte for byte by the tests, together with the files in `test/golden/`
(the v1.1 contract fixture, and the frozen v1.0 fixture with and without its sidecar). `rich-eval-report.json` + `rich-extras.json` are the same
study in the v1.0 + sidecar form. Update goldens deliberately: `pnpm --filter @gran-prix/report exec vitest run -u`.
