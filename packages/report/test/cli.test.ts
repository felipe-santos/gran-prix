import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CONTRACT_FIXTURE, PKG, readJson } from "./helpers.js";

const BIN = `${PKG}bin/gp-report.mjs`;
const RICH = `${PKG}test/fixtures/rich-eval-report.json`;
const EXTRAS = `${PKG}test/fixtures/rich-extras.json`;
const dir = mkdtempSync(join(tmpdir(), "gp-report-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", cwd: dir });

describe("gp-report CLI", () => {
  it("renders a valid report to the file given with -o", () => {
    const out = join(dir, "a.html");
    const r = run(CONTRACT_FIXTURE, "-o", out);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(out);
    expect(readFileSync(out, "utf8")).toContain("f1_vs_readability");
  });

  it("defaults the output name to <input>.report.html in the current directory", () => {
    const r = run(CONTRACT_FIXTURE);
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, "eval-report.report.html"))).toBe(true);
  });

  it("accepts --extras and --compare", () => {
    const out = join(dir, "b.html");
    const r = run(RICH, "--extras", EXTRAS, "--compare", RICH, "-o", out);
    expect(r.status).toBe(0);
    const html = readFileSync(out, "utf8");
    expect(html).toContain('id="chart-pr"');
    expect(html).toContain('<section id="comparison"');
  });

  it("fails clearly on an invalid EvalReport, naming the field", () => {
    const bad = readJson(CONTRACT_FIXTURE) as { threshold: number };
    bad.threshold = 7;
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify(bad));
    const r = run(file, "-o", join(dir, "bad.html"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not a valid EvalReport");
    expect(r.stderr).toContain("threshold");
    expect(existsSync(join(dir, "bad.html"))).toBe(false);
  });

  it("fails on a tampered report_id", () => {
    const bad = readJson(CONTRACT_FIXTURE) as { split: string };
    bad.split = "val";
    const file = join(dir, "tampered.json");
    writeFileSync(file, JSON.stringify(bad));
    const r = run(file);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("id-mismatch");
  });

  it("fails on unreadable or non-JSON input and on bad extras", () => {
    expect(run(join(dir, "missing.json")).status).toBe(1);
    const junk = join(dir, "junk.json");
    writeFileSync(junk, "{nope");
    const j = run(junk);
    expect(j.status).toBe(1);
    expect(j.stderr).toContain("not valid JSON");
    const ex = join(dir, "extras.json");
    writeFileSync(ex, JSON.stringify({ pr_curve: { points: [] } }));
    const e = run(CONTRACT_FIXTURE, "--extras", ex);
    expect(e.status).toBe(1);
    expect(e.stderr).toContain("pr_curve.points");
  });

  it("exits 2 with usage on a usage error and 0 for --help", () => {
    expect(run().status).toBe(2);
    expect(run("--wat", CONTRACT_FIXTURE).status).toBe(2);
    const h = run("--help");
    expect(h.status).toBe(0);
    expect(h.stdout).toContain("usage: gp-report");
  });
});
