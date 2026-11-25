import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sha256 } from "@gran-prix/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, runPipeline } from "../src/index.js";
import { PARAMS, specWith, stage, world } from "./evaluate-fixtures.js";
import { captureIo, cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

describe("gp report", () => {
  let dir: string;
  let reportPath: string;
  let extrasPath: string;

  beforeAll(async () => {
    const w = world();
    const run = await runPipeline(specWith(stage(PARAMS), w.externals), { dataDir: w.dataDir });
    const out = run.stages[0]?.outputs as Record<string, Sha256>;
    dir = tmpDir("gp-report-");
    reportPath = join(dir, "eval-report.json");
    extrasPath = join(dir, "extras.json");
    writeFileSync(reportPath, readFileSync(join(w.store.dirOf(out["report"] as Sha256), "content.json")));
    writeFileSync(extrasPath, readFileSync(join(w.store.dirOf(out["extras"] as Sha256), "content.json")));
  });

  it("renders the produced report and extras to one self-contained HTML file", async () => {
    const io = captureIo(dir);
    const html = join(dir, "report.html");
    expect(await main(["report", reportPath, "--extras", extrasPath, "-o", html], io)).toBe(0);
    expect(io.stdout).toEqual([html]);
    const text = readFileSync(html, "utf8");
    expect(text.startsWith("<!doctype html>")).toBe(true);
    expect(text).toContain("<svg");
    expect(text).toContain("Gates");
    expect(text).toContain("Gain over the heuristic"); // a name that only the extras carry
    expect(text).toContain("dom-fixture-model");
    expect(text).not.toMatch(/<script|src="http|href="http/);
  });

  it("works without extras and writes <input>.report.html in the cwd by default", async () => {
    const io = captureIo(dir);
    expect(await main(["report", reportPath], io)).toBe(0);
    expect(io.stdout[0]).toBe(join(dir, "eval-report.report.html"));
    expect(readFileSync(join(dir, "eval-report.report.html"), "utf8")).toContain("<svg");
  });

  it("is byte-stable: the same inputs render the same HTML", async () => {
    const a = join(dir, "a.html");
    const b = join(dir, "b.html");
    await main(["report", reportPath, "--extras", extrasPath, "-o", a], captureIo(dir));
    await main(["report", reportPath, "--extras", extrasPath, "-o", b], captureIo(dir));
    expect(readFileSync(a, "utf8")).toBe(readFileSync(b, "utf8"));
  });

  it("rejects an invalid report (1), a bad extras file (1) and a missing argument (2)", async () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ ...(JSON.parse(readFileSync(reportPath, "utf8")) as object), threshold: 7 }));
    const io1 = captureIo(dir);
    expect(await main(["report", bad], io1)).toBe(1);
    expect(io1.stderr.join("\n")).toMatch(/not a valid EvalReport/);

    const badExtras = join(dir, "bad-extras.json");
    writeFileSync(badExtras, JSON.stringify({ pr_curve: { points: [] } }));
    const io2 = captureIo(dir);
    expect(await main(["report", reportPath, "--extras", badExtras], io2)).toBe(1);
    expect(io2.stderr.join("\n")).toMatch(/pr_curve\.points/);

    expect(await main(["report"], captureIo(dir))).toBe(2);
  });
});
