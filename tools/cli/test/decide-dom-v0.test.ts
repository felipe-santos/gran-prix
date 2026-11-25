// scripts/decide-dom-v0.mjs: the rules of protocol section 11 on synthetic EvalReports, one scenario per branch, plus the
// refusals (missing inputs, inconsistent reports) and the proof that the thresholds come from the config file.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs without declarations
import { DecisionInputError, decide, main, renderMarkdown } from "../../../scripts/decide-dom-v0.mjs";
import { CATS, GO, evidenceOf, merge, qaReport, testReport, type Evidence, type Scn } from "./decide-fixtures.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(REPO, "pipelines/dom-v0-decision.json"), "utf8")) as Record<string, any>;
const run = (s: Scn, patch?: (e: Evidence) => void, config: Record<string, unknown> = CONFIG): any => {
  const e = evidenceOf(s);
  patch?.(e);
  return decide(e, config);
};

// -- the scenarios: each changes only what its branch needs
const PIVOT_BY_DELTA: Scn = merge(GO, { base: { ...GO.base, "router-oracle": { hard: 0.58, article: 0.82 } }, mlpHard: () => 0.62 });
const PIVOT_BY_G1B: Scn = merge(GO, { base: { ...GO.base, "router-oracle": { hard: 0.67, article: 0.82 } } });
const COND: Scn = merge(GO, { mlpHard: (c) => (c === "product" || c === "docs" ? 0.72 : 0.6) });
// MLP much better on one page of each category and worse on the other: mean +0.08 over readability, but the intervals reach below zero
const INCONCLUSIVE: Scn = merge(GO, { mlpHard: (_c, i) => (i === 0 ? 0.9 : 0.46), g1aCi: (d) => [-0.02, d + 0.1] });

describe("section 11: the five outcomes, in the fixed order", () => {
  it("GO: G1a, G1b, G2, G3 and G4 hold", () => {
    const d = run(GO);
    expect(d.verdict).toBe("GO");
    expect(d.rule_fired).toBe(2);
    expect(d.gates.G0).toMatchObject({ passed: true, best_individual: "readability" });
    expect(d.gates.G0.delta).toBeCloseTo(0.05, 12);
    expect(d.gates.G1a).toMatchObject({ passed: true, baseline: "readability" });
    expect(d.gates.G1a.delta).toBeCloseTo(0.08, 12);
    expect(d.gates.G1a.ci_lower).toBeCloseTo(0.03, 12);
    expect(d.gates.G1b.delta).toBeCloseTo(0.06, 12);
    expect(d.gates.G2).toMatchObject({ passed: true, baseline: "trafilatura-default" });
    expect(d.gates.G2.pooled_n_pages).toBe(6);
    expect(d.gates.G3.passed && d.gates.G4.passed && d.gates.G5.passed && d.gates.G6.passed).toBe(true);
    expect(d.steps.map((s: any) => s.fires)).toEqual([false, true, true, false, true]); // what each rule says on its own; the first one that fires wins
    expect(d.categories.eligible).toEqual([...CATS]);
    expect(d.flags.inconclusive_zone.raised).toBe(false);
  });

  it("conditional GO: G1a fails (mean +0.048) but product and docs are eligible, G2 and G4 hold", () => {
    const d = run(COND);
    expect(d.verdict).toBe("GO-CONDICIONAL");
    expect(d.rule_fired).toBe(3);
    expect(d.gates.G1a.passed).toBe(false);
    expect(d.gates.G1a.delta).toBeCloseTo(0.048, 12);
    expect(d.categories.eligible).toEqual(["product", "docs"]);
    expect(d.categories.detail.forum.checks.delta.passed).toBe(false);
    expect(d.categories.detail.product).toMatchObject({ baseline: "router-oracle", eligible: true });
    expect(d.gates.G3_on_eligible).toMatchObject({ passed: true, categories: ["product", "docs"] });
    expect(d.gates.G3_on_eligible.approximation).toMatch(/POINT delta/);
  });

  it("eligibility needs every one of its conditions: QA loss, retention and D2 each veto a category on their own", () => {
    const worseQa = run(COND, (e) => {
      for (const r of ["r1"] as const) e.qa[r] = qaReport(merge(COND, { qa: { ...COND.qa, categoryDelta: (c) => (c === "docs" ? -0.12 : -0.01) } }));
    });
    expect(worseQa.categories.eligible).toEqual(["product"]);
    expect(worseQa.categories.detail.docs.checks.qa_delta_pp.passed).toBe(false);
    expect(worseQa.gates.G3.flagged_categories.r1).toEqual(["docs"]);
    const lowRetention = run(merge(COND, { qa: { ...COND.qa, categoryRetention: (c) => (c === "product" ? 0.9 : 0.97) } }));
    expect(lowRetention.categories.eligible).toEqual(["docs"]);
    const lowD2 = run(merge(COND, { d2By: (c) => (c === "product" ? 1.2 : 2.5) }));
    expect(lowD2.categories.eligible).toEqual(["docs"]);
    expect(lowD2.categories.detail.product.checks.d2_median.passed).toBe(false);
  });

  it("PIVOT because G1a fails with a delta under its threshold (the 0.02 - 0.05 zone falls here)", () => {
    const d = run(PIVOT_BY_DELTA);
    expect(d.verdict).toBe("PIVOT");
    expect(d.rule_fired).toBe(4);
    expect(d.gates.G1a.passed).toBe(false);
    expect(d.gates.G1a.delta).toBeCloseTo(0.02, 12);
    expect(d.gates.G1b.passed).toBe(true);
    expect(d.pivot_reason).toHaveLength(1);
    expect(d.pivot_reason[0]).toMatch(/G1a delta 0\.02/);
    expect(d.categories.eligible).toEqual([]);
    expect(d.gates.G3_router.passed && d.gates.G4_router.passed).toBe(true);
  });

  it("PIVOT because G1b fails although G1a holds (the router is as good as the MLP)", () => {
    const d = run(PIVOT_BY_G1B);
    expect(d.verdict).toBe("PIVOT");
    expect(d.gates.G1a.passed).toBe(true);
    expect(d.gates.G1b.passed).toBe(false);
    expect(d.gates.G1b.delta).toBeCloseTo(0.01, 12);
    expect(d.pivot_reason).toHaveLength(1);
    expect(d.pivot_reason[0]).toMatch(/G1b delta 0\.01/);
  });

  it("NO-GO when the router cannot carry the pivot (its G4 fails); no rescue arm because G3 holds", () => {
    const d = run(merge(PIVOT_BY_DELTA, { routerD2: 1.2 }));
    expect(d.verdict).toBe("NO-GO");
    expect(d.rule_fired).toBe(5);
    expect(d.gates.G4_router.passed).toBe(false);
    expect(d.flags.rescue_arm.allowed).toBe(false);
  });

  it("NO-GO caused by G3 of the model alone (the oracle passes): one rescue arm is allowed, and only once", () => {
    const s = merge(PIVOT_BY_DELTA, { qa: { ...PIVOT_BY_DELTA.qa, model: [-0.07, -0.09, -0.03], router: [-0.07, -0.09, -0.03] } });
    const d = run(s);
    expect(d.verdict).toBe("NO-GO");
    expect(d.gates.G3.passed).toBe(false);
    expect(d.gates.G3_router.passed).toBe(false);
    expect(d.flags.rescue_arm).toMatchObject({ allowed: true, recall_target: CONFIG.thresholds.rescue_arm.recall_target });
    const again = run(s, (e) => (e.rescue_done = true));
    expect(again.flags.rescue_arm.allowed).toBe(false);
  });

  it("NO-GO of the concept comes first, whatever else holds: the oracle arm loses more than the limit", () => {
    const s = merge(GO, { qa: { ...GO.qa, oracle: [-0.07, -0.09, -0.05] } });
    const d = run(s);
    expect(d.verdict).toBe("NO-GO-CONCEPT");
    expect(d.rule_fired).toBe(1);
    expect(d.gates.G1a.passed && d.gates.G1b.passed && d.gates.G4.passed).toBe(true); // everything else would have been a GO
    expect(d.steps[0].observed.r1).toMatchObject({ fires: true });
    // a single respondent is enough
    const one = run(GO, (e) => (e.qa.r2 = qaReport(s)));
    expect(one.verdict).toBe("NO-GO-CONCEPT");
  });

  it("INCONCLUSIVE when the delta clears 0.05 but the interval reaches zero; the single extension, once done, lets the NO-GO stand", () => {
    const d = run(INCONCLUSIVE);
    expect(d.verdict).toBe("INCONCLUSIVO");
    expect(d.provisional_if_no_extension).toBe("NO-GO");
    expect(d.gates.G1a.delta).toBeGreaterThanOrEqual(0.05);
    expect(d.gates.G1a.ci_lower).toBeLessThanOrEqual(0);
    expect(d.flags.inconclusive_zone).toMatchObject({ raised: true, extension_done: false });
    expect(d.flags.inconclusive_zone.action).toMatch(/\+40 hard pages/);
    expect(d.categories.eligible).toEqual([]);
    const after = run(INCONCLUSIVE, (e) => (e.extension_done = true));
    expect(after.verdict).toBe("NO-GO");
    expect(after.flags.inconclusive_zone).toMatchObject({ raised: true, extension_done: true });
    // a GO is never held back by the zone flag: it only applies when the rules would end in PIVOT or NO-GO
    expect(run(merge(GO, { g1aCi: (d: number) => [-0.01, d + 0.1] })).verdict).toBe("GO-CONDICIONAL");
  });

  it("the other flags: GBDT beating the MLP by more than the line, G5, G6 and D2 do not change the verdict", () => {
    const d = run(merge(GO, { gbdtHard: 0.75, g5: { ...GO.g5, p95_ms: 400 }, g6: { ...GO.g6, share: 0.5 }, d2: 1.4 }));
    expect(d.flags.gbdt_minus_mlp.investigate).toBe(true);
    expect(d.flags.gbdt_minus_mlp.value).toBeCloseTo(0.07, 12);
    expect(d.flags.g5_blocks_e4_until_optimized).toBe(true);
    expect(d.flags.g6_forbids_logged_in_differentiator).toBe(true);
    expect(d.flags.d2_ml_is_not_the_source).toBe(true);
    // d2 1.4 also fails G4 (>= 2): only here does the verdict move
    expect(d.gates.G4.passed).toBe(false);
    const quiet = run(merge(GO, { gbdtHard: 0.75, g5: { ...GO.g5, p95_ms: 400 }, g6: { ...GO.g6, share: 0.5 } }));
    expect(quiet.verdict).toBe("GO");
    expect(quiet.flags.gbdt_minus_mlp.investigate && quiet.flags.g5_blocks_e4_until_optimized && quiet.flags.g6_forbids_logged_in_differentiator).toBe(true);
  });

  it("the MLP's statistic is the mean over the 5 seeds, and the report keeps the per-seed values", () => {
    const d = run(GO, (e) => (e.test["5"] = testReport(merge(GO, { mlpHard: () => 0.48 }), 5)));
    expect(d.gates.G1a.per_seed).toHaveLength(5);
    expect(d.gates.G1a.delta).toBeCloseTo((4 * 0.08 - 0.12) / 5, 12);
    expect(d.gates.G1a.passed).toBe(false); // 0.04 < 0.05
    expect(d.gates.G1a.ci_lower_min_over_seeds).toBeLessThan(d.gates.G1a.ci_lower);
  });

  it("is a pure, deterministic function of the evidence and the config", () => {
    expect(JSON.stringify(run(COND))).toBe(JSON.stringify(run(COND)));
    const md = renderMarkdown(run(COND));
    expect(md).toContain("# Decision of the DOM experiment: GO-CONDICIONAL");
    expect(md).toContain("Eligible: product, docs");
    for (const g of ["G0", "G1a", "G1b", "G2", "G3", "G4", "G5", "G6"]) expect(md).toContain(g);
    expect(md).toMatch(/\| 1 \| NO-GO of the concept \|/);
  });
});

describe("the thresholds are the config's, not the code's", () => {
  const withConfig = (patch: (c: any) => void): Record<string, unknown> => {
    const c = structuredClone(CONFIG);
    patch(c);
    return c;
  };

  it("raising G1a's delta turns the same evidence from GO into something else; so does the oracle statistic", () => {
    expect(run(GO).verdict).toBe("GO");
    const strict = run(GO, undefined, withConfig((c) => (c.thresholds.G1a.min_delta = 0.1)));
    expect(strict.gates.G1a).toMatchObject({ passed: false, threshold: 0.1 });
    expect(strict.verdict).not.toBe("GO");
    const s = merge(GO, { qa: { ...GO.qa, oracle: [-0.03, -0.08, 0.0] } });
    expect(run(s).verdict).toBe("GO"); // point -3 pp: the oracle holds
    expect(run(s, undefined, withConfig((c) => (c.thresholds.concept_no_go.statistic = "ci_lower"))).verdict).toBe("NO-GO-CONCEPT"); // CI lower -8 pp
    expect(run(s, undefined, withConfig((c) => (c.thresholds.concept_no_go.oracle_delta_pp = -2))).verdict).toBe("NO-GO-CONCEPT");
  });

  it("the script source holds none of the section 8 thresholds as literals", () => {
    const src = readFileSync(join(REPO, "scripts/decide-dom-v0.mjs"), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const lit of ["0.05", "0.03", "0.02", "0.95", "0.98", "-5", "-10", "150", "100000"]) expect(src, `literal ${lit}`).not.toMatch(new RegExp(`(?<![\\w.])${lit.replace(".", "\\.")}(?![\\w.])`));
  });
});

describe("it fails loudly instead of deciding", () => {
  it("lists every missing input at once", () => {
    const e = evidenceOf(GO) as Partial<Evidence>;
    delete (e.qa as Record<string, unknown>)["r2"];
    delete (e.test as Record<string, unknown>)["3"];
    delete e.g5;
    delete e.router_tokens;
    let err: any;
    try {
      decide(e, CONFIG);
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(DecisionInputError);
    expect(err.problems.join("\n")).toMatch(/qa\["r2"\]/);
    expect(err.problems.join("\n")).toMatch(/test\["3"\]/);
    expect(err.problems.join("\n")).toMatch(/g5/);
    expect(err.problems.join("\n")).toMatch(/router_tokens/);
    expect(err.problems.length).toBeGreaterThanOrEqual(4);
  });

  it("refuses a baseline that does not cover a page, a report that contradicts itself, and a malformed QA report", () => {
    const hole = evidenceOf(GO) as any;
    delete hole.dev_oof.intrinsic.per_group[0].f1_by_baseline["trafilatura-recall"];
    expect(() => decide(hole, CONFIG)).toThrow(/"trafilatura-recall" has no per-page F1/);

    const lie = evidenceOf(GO) as any;
    const cmp = lie.test["1"].intrinsic.comparison.find((c: any) => c.stratum === "hard" && c.baseline === "readability");
    cmp.delta += 0.01;
    expect(() => decide(lie, CONFIG)).toThrow(/inconsistent/);

    const noCmp = evidenceOf(GO) as any;
    noCmp.test["2"].intrinsic.comparison = [];
    expect(() => decide(noCmp, CONFIG)).toThrow(/comparison\[\] has no entry "hard" vs "readability"/);

    const badQa = evidenceOf(GO) as any;
    badQa.qa.r1.downstream.paired_deltas = badQa.qa.r1.downstream.paired_deltas.filter((p: any) => p.a !== "oracle");
    expect(() => decide(badQa, CONFIG)).toThrow(/paired_deltas has no entry a="oracle"/);

    const notReport = evidenceOf(GO) as any;
    notReport.g6 = { hello: "world" };
    expect(() => decide(notReport, CONFIG)).toThrow(DecisionInputError);
  });

  it("refuses a G5 measured against the protocol's recipe (too few pages, no throttle)", () => {
    expect(() => run(merge(GO, { g5: { ...GO.g5, n_pages: 5, cpu_throttle: 1 } }))).toThrow(/pages measured.*cpu_throttle/s);
  });

  it("refuses a config without a threshold", () => {
    const c = structuredClone(CONFIG);
    delete c.thresholds.G1b;
    delete c.systems.router;
    expect(() => decide(evidenceOf(GO), c)).toThrow(/systems\.router" is missing[\s\S]*thresholds\.G1b\.min_delta" is missing/);
  });
});

describe("the command line", () => {
  const write = (dir: string, name: string, doc: unknown): string => {
    mkdirSync(join(dir, "r"), { recursive: true });
    const p = join("r", name);
    writeFileSync(join(dir, p), JSON.stringify(doc));
    return p;
  };

  it("reads the evidence manifest, writes decision.json and decision.md, and records the hashes of what it read", () => {
    const dir = tmpDir();
    const e = evidenceOf(COND);
    const manifest = {
      dev_oof: write(dir, "dev.json", e.dev_oof),
      test: Object.fromEntries(Object.entries(e.test).map(([k, v]) => [k, write(dir, `test-${k}.json`, v)])),
      qa: { r1: write(dir, "r1.json", e.qa.r1), r2: write(dir, "r2.json", e.qa.r2) },
      router_tokens: write(dir, "router.json", e.router_tokens),
      g5: write(dir, "g5.json", e.g5),
      g6: write(dir, "g6.json", e.g6),
    };
    writeFileSync(join(dir, "evidence.json"), JSON.stringify(manifest));
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = main(["--evidence", join(dir, "evidence.json"), "--out", join(dir, "out")]);
    out.mockRestore();
    expect(code).toBe(0);
    const decision = JSON.parse(readFileSync(join(dir, "out", "decision.json"), "utf8"));
    expect(decision.verdict).toBe("GO-CONDICIONAL");
    expect(decision.inputs.config_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.keys(decision.inputs.evidence_sha256)).toContain("test.5");
    expect(readFileSync(join(dir, "out", "decision.md"), "utf8")).toContain("GO-CONDICIONAL");
    expect(decision).toEqual(JSON.parse(JSON.stringify(decide(evidenceOf(COND), CONFIG, decision.inputs))));
  });

  it("exits 2, not 0, when an input is missing", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "evidence.json"), JSON.stringify({ dev_oof: "nope.json" }));
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = main(["--evidence", join(dir, "evidence.json"), "--out", join(dir, "out")]);
    const printed = err.mock.calls.map((c) => String(c[0])).join("");
    err.mockRestore();
    expect(code).toBe(2);
    expect(printed).toMatch(/cannot read nope\.json/);
  });
});
