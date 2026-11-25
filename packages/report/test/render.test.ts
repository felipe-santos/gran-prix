import { readFileSync } from "node:fs";
import type { EvalReport } from "@gran-prix/contracts";
import { describe, expect, it } from "vitest";
import { ExtrasError, renderReport } from "../src/index.js";
import { loadExtras, loadRich, loadRichV11, loadV10, loadV10Extras, loadValid, PKG, sectionIds, textOf } from "./helpers.js";

describe("contract fixture (valid EvalReport v1.1)", () => {
  const report = loadValid();
  const html = renderReport(report);
  const text = textOf(html);

  it("is one complete HTML document", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("shows identity and provenance in the header", () => {
    expect(text).toContain(report.report_id);
    expect(text).toContain(report.model_id);
    expect(text).toContain(report.dataset_id);
    expect(text).toContain("2026-11-25T12:00:00Z");
    expect(text).toContain("run-0001");
    expect(text).toContain("ts:evaluate.intrinsic@1.0.0");
    expect(text).toContain("1,234 ms");
  });

  it("lists every stratum and every system, with fixed-decimal numbers", () => {
    for (const s of ["article", "docs"]) expect(text).toContain(s);
    expect(text).toContain("readability");
    expect(text).toContain("Model");
    // article: model P 0.8333.., R 1, F1 0.9090..; baseline P 0.6667.., R 0.8, F1 0.7273..
    for (const n of ["0.833", "1.000", "0.909", "0.667", "0.800", "0.727", "0.750"]) expect(text).toContain(n);
    expect(text).not.toMatch(/0\.8333333/);
    expect(text).toContain("+0.182"); // delta
    expect(text).toContain("[0.082, 0.282]"); // its CI
  });

  it("renders the gate with its rule, observed value and PASS (text plus icon)", () => {
    expect(sectionIds(html)).toContain("gates");
    expect(text).toContain("f1_vs_readability");
    expect(text).toContain("macro_f1_delta &gt;= 0");
    expect(text).toContain("0.182");
    expect(html).toMatch(/<span class="badge pass"><svg[^>]*>.*?<\/svg>PASS<\/span>/);
    // contracts v1.1 enriched the valid EvalReport fixture from 1 gate to 4.
    expect(text).toContain("All 4 gates passed");
    expect(text).toContain("g1a_f1_article");
    expect(text).toContain("g4_token_reduction_d2");
  });

  it("derives the confusion matrix from tp/fp/tn/fn", () => {
    expect(sectionIds(html)).toContain("confusion");
    expect(html).toMatch(/<b>8<\/b><span>88\.9%<\/span>/); // overall TP and recall
    expect(text).toContain("n = 20");
  });

  it('has no "not in this report" line: every v1.1 block is in the report itself', () => {
    expect(text).not.toContain("not in this report");
    expect(text).not.toContain("v1.0.0");
    expect(sectionIds(html)).toContain("notes");
  });

  it("says in one line what a v1.0 report cannot carry, instead of inventing it", () => {
    const old = textOf(renderReport(loadV10()));
    expect(old).toContain("PR curve points are not in this report (EvalReport v1.0.0");
    expect(old).toContain("Per-stratum 95% CIs are not in this report");
    expect(old).toContain("D1 and D2 are not in this report (EvalReport v1.0.0");
    expect(old).toContain("Confidence intervals for gate values are not in this report");
    expect(sectionIds(renderReport(loadV10()))).not.toContain("notes");
  });

  it("omits the gates section when the report has no gates", () => {
    const { gates: _gates, ...rest } = report;
    const out = renderReport(rest as EvalReport);
    expect(sectionIds(out)).not.toContain("gates");
    expect(out).not.toContain("Gates</a>");
  });

  it("copes with a downstream-only report", () => {
    const rich = loadRich();
    const { intrinsic: _i, ...rest } = rich;
    const out = renderReport({ ...rest, mode: "downstream" } as EvalReport);
    expect(textOf(out)).toContain("Intrinsic metrics (per-stratum scores, confusion matrix, PR curve) are not in this report");
    expect(sectionIds(out)).toContain("downstream");
    expect(sectionIds(out)).not.toContain("strata");
  });
});

describe("rich synthetic v1.0 fixture + sidecar (every section)", () => {
  const report = loadRich();
  const extras = loadExtras();
  const html = renderReport(report, { extras });
  const text = textOf(html);

  it("renders the sections in the contract order, with the extras after their parents", () => {
    expect(sectionIds(html)).toEqual(["gates", "strata", "confusion", "pr", "calibration", "tokens", "downstream", "notes", "provenance"]);
  });

  it("has every stratum and every baseline in table, charts and confusion matrices", () => {
    for (const s of Object.keys(report.intrinsic?.by_stratum ?? {})) {
      expect(html).toContain(`<th scope="rowgroup" rowspan="4">${s}</th>`);
      expect(html).toContain(`<h3>${s}</h3><table class="cm">`);
      expect(html).toContain(`>${s}</text>`);
    }
    for (const b of Object.keys(report.intrinsic?.baselines ?? {})) {
      expect(html).toContain(`</span>${b}</td>`);
      expect(html).toContain(`<span>${b}</span>`); // legend
    }
    expect(html.match(/<svg class="chart"/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("shows per-stratum CIs from the extras under the point estimates", () => {
    expect(html).toMatch(/<td class="n">0\.923<span class="ci">\[0\.777, 1\.000\]<\/span><\/td>/);
    expect(text).toContain("95% group-bootstrap CI below it");
  });

  it("shows every gate with threshold, observed value, CI and a readable PASS/FAIL", () => {
    expect(text).toContain("1 of 6 gates failed");
    expect((html.match(/>PASS<\/span>/g) ?? []).length).toBe(5);
    expect((html.match(/>FAIL<\/span>/g) ?? []).length).toBe(2); // the failing gate and the banner
    expect(html).toMatch(/<span class="badge fail"><svg/);
    expect(text).toContain("G4 Token reduction vs D2 (page markdown)");
    expect(text).toContain("&gt;= 2× median");
    expect(text).toContain("95% CI [0.034, 0.128]");
    expect(text).toContain("112.000");
  });

  it("marks the operating threshold on the PR curve", () => {
    expect(html).toContain('<svg class="chart" id="chart-pr"');
    expect(html).toMatch(/<circle class="ring s0"/);
    expect(text).toContain("threshold 0.42: P 0.840, R 0.862");
    expect(text).toContain("PR AUC 0.912");
  });

  it("reports both token denominators", () => {
    expect(text).toContain("D1 · raw HTML (outerHTML)");
    expect(text).toContain("D2 · whole-page markdown");
    expect(text).toContain("11.5×");
    expect(text).toContain("1.8×");
    expect(text).toContain("o200k_base");
  });

  it("shows notes and threats, calibration and downstream arms", () => {
    expect(text).toContain("SYNTHETIC DATA");
    expect(html).toContain('<li class="threat">');
    expect(text).toContain("Expected calibration error (ECE): 0.037");
    expect(text).toContain("pruned_model");
    expect(text).toContain("pruned_model − full_page");
  });
});

describe("self-containment and safety", () => {
  const names = ["contract fixture (v1.1)", "rich v1.0 + sidecar", "rich v1.1", "frozen v1.0 + sidecar"];
  const docs = [
    renderReport(loadValid()),
    renderReport(loadRich(), { extras: loadExtras() }),
    renderReport(loadRichV11()),
    renderReport(loadV10(), { extras: loadV10Extras() }),
  ];

  it.each(docs.map((d, i) => [names[i] as string, d] as const))("%s has no external reference at all", (_n, html) => {
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/(?:src|href|action|poster|srcset)\s*=\s*["']?(?:https?:|\/\/|file:|data:)/i);
    expect(html).not.toMatch(/<(?:script|link|iframe|img|object|embed|video|audio|form)\b/i);
    expect(html).not.toMatch(/@import|url\s*\(/i);
    for (const m of html.matchAll(/href="([^"]*)"/g)) expect(m[1]).toMatch(/^#/);
  });

  it.each(docs.map((d, i) => [names[i] as string, d] as const))("%s supports light and dark and a phone viewport", (_n, html) => {
    expect(html).toContain("@media (prefers-color-scheme:dark)");
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain("@media (max-width:520px)");
    expect(html).toContain("tabular-nums");
  });

  it("is deterministic: same input, same bytes, no clock", () => {
    const again = renderReport(loadRich(), { extras: loadExtras() });
    expect(again).toBe(docs[1]);
    const stamps = new Set([...(docs[1] as string).matchAll(/\b20\d\d-\d\d-\d\dT[\d:.]+Z/g)].map((m) => m[0]));
    expect([...stamps]).toEqual(["2026-11-25T12:00:00Z"]); // only the input's created_at
  });

  it("escapes text that comes from the inputs", () => {
    const evil = '<img src=x onerror="alert(1)">&';
    const escaped = "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;";
    // sidecar text (a v1.0 report) ...
    const viaExtras = renderReport(loadV10(), { extras: { names: { model: evil }, notes: [{ kind: "note", text: evil }] } });
    expect(viaExtras).not.toContain("<img");
    expect(viaExtras).toContain(escaped);
    // ... and the report's own text (v1.1): names, notes, gate names, system.
    const own = structuredClone(loadValid());
    own.names = { model: evil, dataset: evil };
    own.notes = [{ kind: "threat", text: evil }];
    own.system = { kind: "model", name: evil };
    const g = own.gates?.[0];
    if (g) g.name = evil;
    const viaReport = renderReport(own);
    expect(viaReport).not.toContain("<img");
    expect(viaReport).toContain(escaped);
  });

  it("rejects malformed extras with every problem listed", () => {
    const bad = { pr_curve: { points: [{ threshold: 2, precision: 0.5, recall: 0.5 }] }, notes: [{ kind: "oops", text: 1 }] };
    expect(() => renderReport(loadValid(), { extras: bad as never })).toThrow(ExtrasError);
    try {
      renderReport(loadValid(), { extras: bad as never });
    } catch (e) {
      expect((e as ExtrasError).issues.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("comparison (--compare)", () => {
  it("blocks deltas when the datasets differ", () => {
    const html = renderReport(loadValid(), { compare: loadRich() });
    const text = textOf(html);
    expect(text).toContain("Comparison blocked: the reports use different datasets");
    expect(text).not.toContain("Δ precision");
  });

  it("shows deltas per stratum and gate states for the same dataset", () => {
    const a = loadValid();
    const b = structuredClone(a);
    b.report_id = `sha256:${"1".repeat(64)}`;
    const art = b.intrinsic?.by_stratum["article"];
    if (art) art.f1 = 0.8;
    const text = textOf(renderReport(a, { compare: b }));
    expect(text).toContain("Δ precision");
    expect(text).toContain("+0.109"); // 0.909 - 0.800
    expect(text).toContain("both reports are for the same model");
  });
});

describe("golden output", () => {
  it("matches the stored HTML for the v1.1 contract fixture", async () => {
    await expect(renderReport(loadValid())).toMatchFileSnapshot("golden/valid-eval-report.html");
  });

  it("matches the stored HTML for the frozen v1.0 fixture with its sidecar", async () => {
    await expect(renderReport(loadV10(), { extras: loadV10Extras() })).toMatchFileSnapshot("golden/v10-eval-report-with-extras.html");
  });

  it("matches the stored HTML for the frozen v1.0 fixture alone", async () => {
    await expect(renderReport(loadV10())).toMatchFileSnapshot("golden/v10-eval-report.html");
  });

  it("matches the committed example (examples/example-report.html): a v1.1 report, no sidecar", () => {
    const committed = readFileSync(`${PKG}examples/example-report.html`, "utf8");
    expect(renderReport(loadRichV11())).toBe(committed);
  });
});
