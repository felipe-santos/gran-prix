import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/index.js";
import { captureIo, cleanupTmp, demoSpec, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

const FIXTURE_MODEL = fileURLToPath(new URL("../../../packages/contracts/fixtures/valid/model-package", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../examples/demo.pipeline.json", import.meta.url));

function project(): { cwd: string; spec: string } {
  const cwd = tmpDir();
  const spec = join(cwd, "pipeline.json");
  writeFileSync(spec, JSON.stringify(demoSpec()));
  return { cwd, spec: "pipeline.json" };
}

async function gp(cwd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const io = captureIo(cwd, env);
  const code = await main(args, io);
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

describe("gp run", () => {
  it("first run is a cache miss on every stage, the second is a 100% hit", async () => {
    const { cwd, spec } = project();
    const first = await gp(cwd, ["run", spec, "--budget-usd", "5"]);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/ok: 6 ran, 0 cached, 0 failed, 0 skipped/);
    const second = await gp(cwd, ["run", spec, "--budget-usd", "5"]);
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/ok: 0 ran, 6 cached, 0 failed, 0 skipped/);
    expect(second.out).not.toMatch(/\bran\b {2}sha/);
  });

  it("--data-dir keeps everything under the given directory", async () => {
    const { cwd, spec } = project();
    const r = await gp(cwd, ["run", spec, "--budget-usd", "5", "--data-dir", "out/data"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(cwd, "out/data/ledger.jsonl"), "utf8")).toContain('"event":"commit"');
  });

  it("--from/--to/--force are wired through", async () => {
    const { cwd, spec } = project();
    await gp(cwd, ["run", spec, "--budget-usd", "5"]);
    const r = await gp(cwd, ["run", spec, "--budget-usd", "5", "--from", "join", "--force"]);
    expect(r.out).toMatch(/emit_a\s+cached/);
    expect(r.out).toMatch(/join\s+ran/);
    expect(r.out).toMatch(/ok: 2 ran, 2 cached, 0 failed, 0 skipped, 2 out of range/);
    const to = await gp(cwd, ["run", spec, "--budget-usd", "5", "--to", "emit_a"]);
    expect(to.out).toMatch(/ok: 0 ran, 1 cached, 0 failed, 0 skipped, 5 out of range/);
  });

  it("exits 1 on a failed stage and prints it; the budget flag and GP_BUDGET_USD both set the cap", async () => {
    const { cwd, spec } = project();
    const noBudget = await gp(cwd, ["run", spec]);
    expect(noBudget.code).toBe(1);
    expect(noBudget.out).toMatch(/label\s+failed\s+BudgetExceededError/);
    expect(noBudget.out).toMatch(/FAILED: 5 ran, 0 cached, 1 failed/);
    const viaEnv = await gp(cwd, ["run", spec], { GP_BUDGET_USD: "5" });
    expect(viaEnv.code).toBe(0);
    expect(viaEnv.out).toMatch(/label\s+ran/);
  });

  it("--json prints the machine-readable summary", async () => {
    const { cwd, spec } = project();
    const r = await gp(cwd, ["run", spec, "--budget-usd", "5", "--json", "--run-id", "run-json"]);
    const summary = JSON.parse(r.out) as { runId: string; ok: boolean; counts: { ran: number } };
    expect(summary).toMatchObject({ runId: "run-json", ok: true, counts: { ran: 6 } });
  });

  it("runs the shipped example pipeline (transcript source)", async () => {
    const cwd = tmpDir();
    cpSync(EXAMPLE, join(cwd, "demo.json"));
    const miss = await gp(cwd, ["run", "demo.json", "--budget-usd", "1"]);
    const hit = await gp(cwd, ["run", "demo.json", "--budget-usd", "1"]);
    expect(miss.code + hit.code).toBe(0);
    expect(miss.out).toMatch(/ok: 4 ran, 0 cached/);
    expect(hit.out).toMatch(/ok: 0 ran, 4 cached/);
  });

  it("reports an invalid pipeline with its issues and exit 1, an unreadable one with exit 2", async () => {
    const { cwd } = project();
    const bad = demoSpec();
    (bad.stages[0] as { impl: string }).impl = "ts:nope@1.0.0";
    writeFileSync(join(cwd, "bad.json"), JSON.stringify(bad));
    const r = await gp(cwd, ["run", "bad.json"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/unknown implementation "ts:nope@1.0.0"/);
    const missing = await gp(cwd, ["run", "nope.json"]);
    expect(missing.code).toBe(2);
    expect(missing.err).toMatch(/cannot read/);
  });
});

describe("gp validate", () => {
  it("accepts a good pipeline and rejects a cyclic one", async () => {
    const { cwd, spec } = project();
    const ok = await gp(cwd, ["validate", spec]);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/^ok: test-demo, 6 stage\(s\)/);
    const cyc = demoSpec();
    (cyc.stages[0] as { inputs: unknown }).inputs = { in: { stage: "label", output: "out" } };
    writeFileSync(join(cwd, "cyc.json"), JSON.stringify(cyc));
    const bad = await gp(cwd, ["validate", "cyc.json"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/cycle|no input port/i);
  });

  it("validates the example pipeline", async () => {
    const r = await gp(tmpDir(), ["validate", EXAMPLE]);
    expect(r.code).toBe(0);
  });
});

describe("gp model check", () => {
  it("passes the contracts fixture with all nine checks", async () => {
    for (const runtime of ["ts", "wasm"]) {
      const r = await gp(tmpDir(), ["model", "check", FIXTURE_MODEL, "--runtime", runtime]);
      expect(r.code).toBe(0);
      expect(r.out.match(/ok {4}\d\/9/g)).toHaveLength(9);
      expect(r.out).toMatch(/model_id sha256:[0-9a-f]{64}/);
    }
  });

  it("fails naming the check when the package is corrupted", async () => {
    const dir = tmpDir();
    cpSync(FIXTURE_MODEL, dir, { recursive: true });
    const w = new Uint8Array(readFileSync(join(dir, "weights.f32le")));
    w[0] = (w[0] as number) ^ 1;
    writeFileSync(join(dir, "weights.f32le"), w);
    const r = await gp(tmpDir(), ["model", "check", dir]);
    expect(r.code).toBe(1);
    expect(r.out.match(/ok {4}\d\/9/g)).toHaveLength(2); // checks 1 and 2 passed
    expect(r.err).toMatch(/FAIL {2}3\/9 digests/);
    expect(r.err).toMatch(/model package check failed: digests/);
    const json = await gp(tmpDir(), ["model", "check", dir, "--json"]);
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, check: "digests", check_number: 3 });
  });
});

describe("gp lineage / ledger / usage", () => {
  it("lineage prints the chain of a stored artifact by id prefix", async () => {
    const { cwd, spec } = project();
    const run = await gp(cwd, ["run", spec, "--budget-usd", "5", "--json"]);
    const summary = JSON.parse(run.out) as { stages: Array<{ stageId: string; outputs: { out: string } }> };
    const label = summary.stages.find((s) => s.stageId === "label")?.outputs.out as string;
    const r = await gp(cwd, ["lineage", label.slice(0, 16)]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/<- label \(ts:demo\.spend@1\.0\.0/);
    expect(r.out).toMatch(/<- join/);
    expect(r.out).toMatch(/<- emit_a/);
  });

  it("ledger summarizes spending against the cap", async () => {
    const { cwd, spec } = project();
    await gp(cwd, ["run", spec, "--budget-usd", "5"]);
    const r = await gp(cwd, ["ledger", "--budget-usd", "5"]);
    expect(r.out).toMatch(/spent\/reserved \$0\.5000 {2}cap \$5\.00 {2}remaining \$4\.5000/);
    expect(r.out).toMatch(/label\s+\$0\.5000 committed/);
  });

  it("usage errors exit 2", async () => {
    const cwd = tmpDir();
    expect((await gp(cwd, ["frobnicate"])).code).toBe(2);
    expect((await gp(cwd, ["run"])).code).toBe(2);
    expect((await gp(cwd, ["run", "x.json", "--bogus"])).code).toBe(2);
    expect((await gp(cwd, ["model", "weigh"])).code).toBe(2);
    expect((await gp(cwd, ["run", "x.json", "--budget-usd", "lots"])).code).toBe(2);
    expect((await gp(cwd, ["--help"])).code).toBe(0);
  });
});
