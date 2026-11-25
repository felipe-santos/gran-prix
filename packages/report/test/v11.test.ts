import type { EvalReport } from "@gran-prix/contracts";
import { describe, expect, it } from "vitest";
import { renderReport } from "../src/index.js";
import { comparatorSymbol, factor, unitPair, unitValue } from "../src/format.js";
import { loadExtras, loadRich, loadRichV11, loadV10, loadV10Extras, loadValid, sectionIds, textOf } from "./helpers.js";

type Gates = NonNullable<EvalReport["gates"]>;

describe("v1.1 contract fixture: every v1.1 section comes from the report alone (no sidecar)", () => {
  const report = loadValid();
  const html = renderReport(report);
  const text = textOf(html);

  it("uses the report's own title, names, system and notes", () => {
    expect(text).toContain("gp-mlp-fixture (synthetic) on fixture dataset (synthetic)");
    expect(text).toContain("model · mlp · gp-mlp-fixture 0.1.0"); // system.kind, family, name, version
    expect(text).toContain("Synthetic report: every number is invented");
    expect(html).toContain('<li class="threat">');
  });

  it("states the methods: weighting unit and bootstrap", () => {
    expect(text).toContain("Counts are in chars");
    expect(text).toContain("positive class: keep (main + support)");
    expect(text).toContain("weights: dataset-row.w (own-text chars)");
    expect(text).toContain("percentile bootstrap, 10,000 resamples, seed 20261125, resampling registrable domains (group_key) inside each stratum");
  });

  it("shows per-stratum CIs from the report's metric_ci and the baseline coverage", () => {
    expect(text).toContain("Point estimate with 95% group-bootstrap CI below it");
    expect(html).toMatch(/<td class="n">0\.909<span class="ci">\[0\.700, 1\.000\]<\/span><\/td>/);
    expect(text).toContain("coverage 97.0%");
  });

  it("shows aggregates (micro and macro), by_tag and the comparison with its aggregation", () => {
    expect(text).toContain("Aggregates");
    expect(text).toMatch(/hard docs 0\.750 P 0\.750 · R 0\.750 · n 9 0\.720 0\.750 \[0\.550, 0\.880\]/);
    expect(text).toContain("By tag");
    expect(text).toContain("lang:en");
    expect(text).toContain("logged_in");
    expect(text).toContain("macro by page"); // comparison[].aggregation
    expect(text).toContain("Token F1"); // a non-f1 comparison metric gets its own panel and rows
    expect(html).toContain('id="chart-delta-recall"');
    expect(html).toContain('id="chart-delta-token_f1"');
    expect(text).toMatch(/article F1 macro by page readability/); // table: metric, aggregation, baseline
  });

  it("draws the PR curve from the report and names how the operating point was chosen", () => {
    expect(html).toContain('id="chart-pr"');
    expect(text).toContain("Operating point chosen by: max threshold with char-weighted recall &gt;= 0.85 on dev (fixture value).");
  });

  it("shows D1 and D2 with median, IQR and the × factor, the converter and the by-stratum details", () => {
    expect(text).toContain("D1 · raw HTML (outerHTML)");
    expect(text).toContain("D2 · whole-page markdown");
    expect(text).toContain("50.0× IQR 33.3× to 83.3× kept/full 0.020 (IQR [0.012, 0.030])");
    expect(text).toContain("2.5× IQR 2.0× to 3.3× kept/full 0.400 (IQR [0.300, 0.500])");
    expect(text).toContain("Tokenizer: cl100k_base"); // the report's token_reduction, not token_stats' o200k_base
    expect(text).not.toContain("o200k_base");
    expect(text).toContain("turndown@7.2.0+gfm");
    expect(text).toContain("D1: rendered outerHTML after settle, data-gp-* stripped");
    expect(text).toContain("By stratum (median over pages)");
    expect(text).not.toContain("denominator not stated"); // token_stats would repeat D2
  });

  it("shows the G5 runtime block", () => {
    expect(sectionIds(html)).toContain("runtime");
    expect(text).toContain("p95 latency 112.4 ms");
    expect(text).toContain("p50 latency 61 ms");
    expect(text).toContain("Model size 82.0 KiB");
    expect(text).toContain("1,500 to 3,000 elements");
    expect(text).toContain("4× slowdown");
    expect(text).toContain("chromium-headless, 4x CPU throttle");
  });

  it("drops every 'not in this report' note", () => {
    expect(text).not.toContain("not in this report");
    expect(text).not.toContain("EvalReport v1.0.0");
  });

  it("renders the weakest-groups table with group_key when the report has it", () => {
    expect(text).toContain("Group key");
    expect(text).toContain("site0.example");
  });
});

describe("rich synthetic v1.1 report (every section, no sidecar)", () => {
  const html = renderReport(loadRichV11());
  const text = textOf(html);

  it("has every section, gates first and provenance last", () => {
    expect(sectionIds(html)).toEqual(["gates", "strata", "confusion", "pr", "calibration", "tokens", "runtime", "downstream", "notes", "provenance"]);
  });

  it("shows the downstream v1.1 fields: bootstrap, human agreement and evidence retention", () => {
    expect(text).toContain("agreement with human raters 0.870");
    expect(text).toContain("Evidence retained (95% CI)");
    expect(html).toMatch(/<td class="n">0\.930<span class="ci">\[0\.900, 0\.960\]<\/span><\/td>/);
    expect(text).toContain("CIs: percentile bootstrap, 10,000 resamples");
  });

  it("names baselines' coverage, aggregation and the hard aggregate", () => {
    expect(text).toContain("coverage 94.0%");
    expect(text).toContain("Macro F1, by stratum");
    expect(text).toMatch(/hard F1 macro by page trafilatura/);
  });
});

describe("a frozen v1.0 fixture still renders, with the sidecar as the fallback", () => {
  const v10 = loadV10();

  it("without a sidecar it says what it lacks, in the v1.0 wording", () => {
    const text = textOf(renderReport(v10));
    expect(text).toContain("PR curve points are not in this report (EvalReport v1.0.0");
    expect(text).toContain("D1 and D2 are not in this report (EvalReport v1.0.0");
    expect(text).toContain("Per-stratum 95% CIs are not in this report");
    expect(text).toContain("Contract token_stats (denominator not stated)");
    expect(text).not.toContain("Methods.");
  });

  it("with a sidecar it shows names, CIs, PR curve, D1/D2, gate details and notes as before", () => {
    const html = renderReport(v10, { extras: loadV10Extras() });
    const text = textOf(html);
    expect(text).toContain("legacy-model (sidecar) on legacy-dataset (sidecar)");
    expect(html).toMatch(/<td class="n">0\.909<span class="ci">\[0\.700, 1\.000\]<\/span><\/td>/);
    expect(html).toContain('id="chart-pr"');
    expect(text).toContain("50.0×"); // 1 / 0.02, derived from the sidecar median_ratio
    expect(text).toContain("D2 · whole-page markdown");
    expect(text).toContain("G1 F1 gain over readability (sidecar)");
    expect(text).toContain("&gt;= 0 F1 difference");
    expect(text).toContain("95% CI [0.082, 0.282]");
    expect(text).toContain("Sidecar note: the baselines were tuned");
    expect(text).not.toContain("PR curve points are not in this report");
    expect(text).toContain("Contract token_stats (denominator not stated)"); // legacy rows are kept
  });
});

describe("when both the report and the sidecar carry a field, the report wins", () => {
  const report = loadValid();
  const rival = {
    names: { model: "SIDECAR-MODEL", dataset: "SIDECAR-DATASET" },
    metric_ci: { model: { article: { f1: [0.111, 0.222] as [number, number] } } },
    pr_curve: { points: [{ threshold: 0.2, precision: 0.3117, recall: 0.3217 }, { threshold: 0.8, precision: 0.3317, recall: 0.3417 }] },
    token_reduction: { tokenizer: "SIDECAR-TOKENIZER", d2: { full_tokens: 1000, kept_tokens: 900, median_ratio: 0.9 } },
    gate_details: { g4_token_reduction_d2: { name: "SIDECAR GATE NAME", ci95: [1, 9] as [number, number] }, f1_vs_readability: { name: "Sidecar name for a v1.0-style gate" } },
    notes: [{ kind: "note" as const, text: "SIDECAR NOTE" }],
  };
  const text = textOf(renderReport(report, { extras: rival }));

  it("takes names, notes, CIs, PR curve and tokens from the report", () => {
    expect(text).not.toContain("SIDECAR-");
    expect(text).not.toContain("SIDECAR NOTE");
    expect(text).not.toContain("0.111");
    expect(text).not.toContain("0.312");
    expect(text).toContain("gp-mlp-fixture (synthetic) on fixture dataset (synthetic)");
    expect(text).toContain("Tokenizer: cl100k_base");
    expect(text).toContain("Synthetic report: every number is invented");
  });

  it("keeps the gate's own name and CI, and uses the sidecar only for a field the gate lacks", () => {
    expect(text).not.toContain("SIDECAR GATE NAME");
    expect(text).toContain("G4 token reduction vs full-page markdown");
    expect(text).not.toContain("95% CI [1, 9]");
    expect(text).toContain("Sidecar name for a v1.0-style gate"); // gate without a name: the sidecar fills the gap
  });

  it("is the same document as without the sidecar, except for that filled gap", () => {
    const plain = renderReport(report);
    const withRival = renderReport(report, { extras: { names: rival.names, notes: rival.notes, metric_ci: rival.metric_ci, pr_curve: rival.pr_curve, token_reduction: rival.token_reduction } });
    expect(withRival).toBe(plain);
  });
});

describe("layout: the decision first, provenance collapsed", () => {
  const html = renderReport(loadRichV11());
  const gatesAt = html.indexOf('<section id="gates"');
  const strataAt = html.indexOf('<section id="strata"');

  it("puts the gates right after the title and identity block, before any metric", () => {
    expect(html.indexOf("<h1>")).toBeLessThan(gatesAt);
    expect(gatesAt).toBeGreaterThan(0);
    expect(gatesAt).toBeLessThan(strataAt);
    expect(sectionIds(html)[0]).toBe("gates");
    // between the title and the gates there is only the compact identity block and the section links
    const head = html.slice(html.indexOf("<header"), gatesAt);
    expect(head.length).toBeLessThan(2500);
  });

  it("keeps hashes out of the visible text before the gates", () => {
    const beforeGates = textOf(html.slice(html.indexOf("<body>"), gatesAt));
    expect(beforeGates).not.toMatch(/[0-9a-f]{64}/);
    expect(beforeGates).toMatch(/sha256:[0-9a-f]{8}…[0-9a-f]{6}/); // short ids, full value in the title attribute
    expect(html).toMatch(/<code title="sha256:[0-9a-f]{64}">sha256:[0-9a-f]{8}…/);
  });

  it("has Provenance as the last section, in a <details> that is closed", () => {
    expect(sectionIds(html).at(-1)).toBe("provenance");
    const details = html.match(/<details class="prov"[^>]*>/g) ?? [];
    expect(details).toEqual(['<details class="prov">']); // no `open` attribute
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(textOf(html.slice(html.indexOf('<section id="provenance"')))).toContain("run-0042");
  });

  it("has the decision banner and every gate verdict as text plus an icon", () => {
    expect(textOf(html)).toContain("1 of 7 gates failed");
    expect((html.match(/<li class="gate (?:pass|fail)">/g) ?? []).length).toBe(7);
    expect(html).toMatch(/<li class="gate fail">.*?<span class="badge fail"><svg/);
  });
});

describe("units on gate values", () => {
  it("formats per unit with sensible decimals", () => {
    expect(unitValue(112.4, "ms")).toBe("112.4 ms");
    expect(unitValue(150, "ms")).toBe("150 ms");
    expect(unitValue(112, "ms")).toBe("112 ms");
    expect(unitValue(11.5, "x")).toBe("11.5×");
    expect(unitValue(2, "x")).toBe("2×");
    expect(unitValue(0.18181818, "f1")).toBe("0.182 F1");
    expect(unitValue(0, "f1")).toBe("0.000 F1");
    expect(unitValue(-2.6, "pp")).toBe("−2.6 pp");
    expect(unitValue(5, "pp")).toBe("5 pp");
    expect(unitValue(0.61234, "kappa")).toBe("0.612 κ");
    expect(unitValue(0.5, "ratio")).toBe("0.500");
    expect(unitValue(84000, "bytes")).toBe("82.0 KiB");
    expect(unitValue(512, "bytes")).toBe("512 B");
    expect(unitValue(3 * 1024 * 1024, "bytes")).toBe("3.0 MiB");
    expect(unitValue(0.182, undefined)).toBe("0.182"); // no unit: the legacy three decimals
    expect(unitValue(7, "widgets")).toBe("7 widgets"); // unknown unit: shown as given
    expect(unitValue(Number.NaN, "ms")).toBe("n/a");
  });

  it("signs differences and never prints +0 or -0", () => {
    expect(unitValue(0.081, "f1", { signed: true })).toBe("+0.081 F1");
    expect(unitValue(-0.004, "f1", { signed: true })).toBe("−0.004 F1");
    expect(unitValue(0, "f1", { signed: true })).toBe("0.000 F1");
    expect(unitValue(0.0001, "f1", { signed: true })).toBe("0.000 F1");
    expect(unitValue(-0.0001, "f1")).toBe("0.000 F1");
  });

  it("adds decimals so that an observed value never looks equal to the threshold it failed", () => {
    expect(unitPair(1.96, 2, "x")).toEqual(["1.96×", "2×"]);
    expect(unitPair(1.8, 2, "x")).toEqual(["1.8×", "2×"]);
    expect(unitPair(0.1499, 0.15, "f1")).toEqual(["0.1499 F1", "0.1500 F1"]);
    expect(unitPair(150, 150, "ms")).toEqual(["150 ms", "150 ms"]);
  });

  it("maps comparators to symbols and prints factors with one decimal", () => {
    expect([">=", "<=", ">", "<", "=="].map(comparatorSymbol)).toEqual(["≥", "≤", ">", "<", "="]);
    expect(factor(50)).toBe("50.0×");
    expect(factor(0)).toBe("n/a");
  });

  it("renders the gate values of the rich report with units, not as bare three-decimal numbers", () => {
    const text = textOf(renderReport(loadRichV11()));
    expect(text).toContain("Observed 112.4 ms ≤ 150 ms");
    expect(text).toContain("Observed 11.5× ≥ 10×");
    expect(text).toContain("Observed 1.8× ≥ 2×");
    expect(text).toContain("Observed −2.6 pp ≥ −5 pp");
    expect(text).toContain("Observed 82.0 KiB ≤ 256.0 KiB");
    expect(text).toContain("Observed −0.004 F1 ≥ −0.020 F1");
    expect(text).not.toContain("112.000");
    expect(text).not.toContain("11.500");
    expect(text).not.toContain("150.000");
  });

  it("keeps the v1.0 three decimals for a gate without a unit", () => {
    const text = textOf(renderReport(loadRich(), { extras: loadExtras() }));
    expect(text).toContain("112.000");
  });
});

describe("gates decided on a CI bound", () => {
  const html = renderReport(loadRichV11());
  const card = (id: string): string => {
    const at = html.indexOf(`<code>${id}</code>`);
    return html.slice(html.lastIndexOf('<li class="gate', at), html.indexOf("</li>", at));
  };

  it("shows the CI, marks the lower bound that decided a >= gate, and says so", () => {
    const g1 = card("g1_hard_strata_gain");
    expect(textOf(g1)).toContain("CI lower bound +0.052 F1 ≥ +0.050 F1");
    expect(textOf(g1)).toContain("Point estimate +0.081 F1");
    expect(g1).toContain('[<mark class="decider" title="the bound that decided this gate">+0.052 F1</mark>, +0.128 F1]');
    expect(textOf(g1)).toContain("decided on the lower bound");
    expect((g1.match(/<mark/g) ?? []).length).toBe(1);
  });

  it("marks the upper bound for a <= gate", () => {
    const report = structuredClone(loadValid());
    const gates: Gates = [
      { id: "latency", rule: "p95 <= 150 ms, on the CI upper bound", value: 140, passed: true, comparator: "<=", threshold: 150, unit: "ms", observed: 120, ci95: [100, 140], use_ci_lower: true },
    ];
    report.gates = gates;
    const out = renderReport(report);
    expect(out).toContain('[100 ms, <mark class="decider" title="the bound that decided this gate">140 ms</mark>]');
    expect(textOf(out)).toContain("CI upper bound 140 ms ≤ 150 ms");
    expect(textOf(out)).toContain("decided on the upper bound");
  });

  it("shows the CI of a point-estimate gate without marking a bound", () => {
    const g2 = card("g2_no_article_regression");
    expect(g2).not.toContain("<mark");
    expect(textOf(g2)).toContain("95% CI [−0.031 F1, +0.022 F1]");
    expect(textOf(g2)).toContain("the point estimate decides");
  });

  it("renders a failing CI-bound gate as FAIL", () => {
    const report = structuredClone(loadValid());
    const gates: Gates = [{ id: "g", rule: "r", value: -0.031, passed: false, comparator: ">=", threshold: -0.02, unit: "f1", observed: -0.004, ci95: [-0.031, 0.022], use_ci_lower: true }];
    report.gates = gates;
    const out = renderReport(report);
    expect(textOf(out)).toContain("1 of 1 gate failed");
    expect(out).toContain('<li class="gate fail">');
  });
});

describe("downstream-only and partial v1.1 reports", () => {
  it("copes with a v1.1 report that has no intrinsic block", () => {
    const { intrinsic: _i, ...rest } = loadRichV11();
    const out = renderReport({ ...rest, mode: "downstream" } as EvalReport);
    expect(sectionIds(out)).toEqual(["gates", "downstream", "notes", "provenance"]);
    expect(textOf(out)).toContain("Intrinsic metrics (per-stratum scores, confusion matrix, PR curve) are not in this report");
    // the notice sits after the gates, never before them
    expect(out.indexOf('<section id="gates"')).toBeLessThan(out.indexOf("Intrinsic metrics (per-stratum"));
  });

  it("omits the runtime section and the methods line when the report has neither", () => {
    const r = structuredClone(loadRichV11());
    if (r.intrinsic) {
      delete r.intrinsic.runtime;
      delete r.intrinsic.weighting;
      delete r.intrinsic.bootstrap;
    }
    const out = renderReport(r);
    expect(sectionIds(out)).not.toContain("runtime");
    expect(out).not.toContain('class="methods"');
  });

  it("is deterministic", () => {
    expect(renderReport(loadRichV11())).toBe(renderReport(loadRichV11()));
  });
});
