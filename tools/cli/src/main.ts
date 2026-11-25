import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ContractError, type ContractIssue } from "@gran-prix/contracts";
import { CHECKS, ModelPackageError, loadModelPackage, type Runtime } from "@gran-prix/model";
import { Ledger } from "./ledger.js";
import { lineageOf, type LineageNode } from "./lineage.js";
import { dataPaths, shortId } from "./paths.js";
import { checkPipeline, runPipeline } from "./runner.js";
import { StageRegistry } from "./stage.js";
import { ALL_STAGES } from "./stages/index.js";
import { ArtifactStore } from "./store.js";
import { PipelineValidationError, type StageResult } from "./types.js";
import { GP_VERSION } from "./version.js";

export interface Io {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
}

export const processIo = (): Io => ({
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  cwd: process.cwd(),
  env: process.env,
});

const USAGE = `gp ${GP_VERSION}: pipeline runner

usage:
  gp run <pipeline.json> [--from <stage>] [--to <stage>] [--force] [--data-dir data]
                         [--budget-usd N] [--run-id ID] [--root DIR] [--json]
  gp validate <pipeline.json>
  gp model check <model-dir> [--runtime ts|wasm] [--json]
  gp lineage <artifact-id|prefix> [--data-dir data]
  gp ledger [--data-dir data] [--budget-usd N]

exit status: 0 ok, 1 failed (validation, stage or check), 2 usage error`;

class UsageError extends Error {}

const OPTIONS = {
  from: { type: "string" },
  to: { type: "string" },
  force: { type: "boolean" },
  "data-dir": { type: "string" },
  "budget-usd": { type: "string" },
  "run-id": { type: "string" },
  root: { type: "string" },
  runtime: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

interface Parsed {
  values: {
    from?: string;
    to?: string;
    force?: boolean;
    "data-dir"?: string;
    "budget-usd"?: string;
    "run-id"?: string;
    root?: string;
    runtime?: string;
    json?: boolean;
    help?: boolean;
  };
  positionals: string[];
}

function parse(args: string[]): Parsed {
  try {
    return parseArgs({ args, options: OPTIONS, allowPositionals: true }) as Parsed;
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

const positional = (p: Parsed, i: number, what: string): string => {
  const v = p.positionals[i];
  if (v === undefined) throw new UsageError(`missing <${what}>`);
  return v;
};

function budgetOf(p: Parsed, io: Io): number {
  const raw = p.values["budget-usd"] ?? io.env["GP_BUDGET_USD"];
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--budget-usd must be a number >= 0 (got ${raw})`);
  return n;
}

const dataDirOf = (p: Parsed, io: Io): string => resolve(io.cwd, p.values["data-dir"] ?? "data");

function readSpec(path: string, io: Io): unknown {
  const file = resolve(io.cwd, path);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function printIssues(io: Io, issues: readonly ContractIssue[]): void {
  for (const i of issues) io.err(`  ${i.code.padEnd(10)} ${i.path}: ${i.message}`);
}

/** Entry point; returns the process exit code. */
export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  try {
    const p = parse(argv);
    const [cmd, sub] = p.positionals;
    if (p.values.help || cmd === undefined || cmd === "help") {
      io.out(USAGE);
      return cmd === undefined && !p.values.help ? 2 : 0;
    }
    const rest = { ...p, positionals: p.positionals.slice(1) };
    switch (cmd) {
      case "run":
        return await runCommand(rest, io);
      case "validate":
        return validateCommand(rest, io);
      case "model":
        if (sub !== "check") throw new UsageError('unknown "model" subcommand (expected: gp model check <dir>)');
        return modelCheckCommand({ ...p, positionals: p.positionals.slice(2) }, io);
      case "lineage":
        return lineageCommand(rest, io);
      case "ledger":
        return ledgerCommand(rest, io);
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`gp: ${e.message}`);
      io.err("run `gp help` for usage");
      return 2;
    }
    io.err(`gp: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

// ------------------------------------------------------------------ run

function stageLine(r: StageResult): string {
  const first = Object.values(r.outputs).flat()[0];
  const detail =
    r.status === "failed" ? `  ${r.error ?? ""}` : r.status === "skipped" ? `  (${r.reason ?? ""})` : first ? `  ${shortId(first)}` : "";
  const cost = r.costUSD > 0 ? `  $${r.costUSD.toFixed(4)}` : "";
  return `  ${r.stageId.padEnd(16)} ${r.status.padEnd(8)}${detail}${r.status === "ran" ? `  ${r.durationMs}ms` : ""}${cost}`;
}

async function runCommand(p: Parsed, io: Io): Promise<number> {
  const specPath = positional(p, 0, "pipeline.json");
  const raw = readSpec(specPath, io);
  const dataDir = dataDirOf(p, io);
  const json = p.values.json === true;
  const budget = budgetOf(p, io);
  try {
    const summary = await runPipeline(raw, {
      dataDir,
      root: resolve(io.cwd, p.values.root ?? "."),
      budgetUSD: budget,
      ...(p.values.from !== undefined ? { from: p.values.from } : {}),
      ...(p.values.to !== undefined ? { to: p.values.to } : {}),
      ...(p.values.force ? { force: true } : {}),
      ...(p.values["run-id"] !== undefined ? { runId: p.values["run-id"] } : {}),
      onStage: (r) => {
        if (!json) io.out(stageLine(r));
      },
      log: (stage, msg) => {
        if (!json) io.out(`  [${stage}] ${msg}`);
      },
    });
    if (json) {
      io.out(JSON.stringify(summary, null, 2));
    } else {
      const c = summary.counts;
      io.out(
        `${summary.ok ? "ok" : "FAILED"}: ${c.ran} ran, ${c.cached} cached, ${c.failed} failed, ${c.skipped} skipped` +
          `${c["out-of-range"] ? `, ${c["out-of-range"]} out of range` : ""}  (run ${summary.runId}, receipts in ${summary.dir})`,
      );
    }
    return summary.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof PipelineValidationError || e instanceof ContractError) {
      io.err(`gp: ${specPath} is not a valid pipeline`);
      printIssues(io, e.issues);
      return 1;
    }
    throw e;
  }
}

// ------------------------------------------------------------- validate

function validateCommand(p: Parsed, io: Io): number {
  const specPath = positional(p, 0, "pipeline.json");
  const r = checkPipeline(readSpec(specPath, io), new StageRegistry(ALL_STAGES));
  if (!r.ok) {
    io.err(`gp: ${specPath} is not valid (${r.issues.length} issue(s))`);
    printIssues(io, r.issues);
    return 1;
  }
  io.out(`ok: ${r.spec.name}, ${r.spec.stages.length} stage(s): ${r.spec.stages.map((s) => s.id).join(" -> ")}`);
  return 0;
}

// ---------------------------------------------------------- model check

function modelCheckCommand(p: Parsed, io: Io): number {
  const dir = resolve(io.cwd, positional(p, 0, "model-dir"));
  const runtime = p.values.runtime ?? "ts";
  if (runtime !== "ts" && runtime !== "wasm") throw new UsageError('--runtime must be "ts" or "wasm"');
  try {
    const m = loadModelPackage(dir, { runtime: runtime as Runtime });
    if (p.values.json) {
      io.out(JSON.stringify({ ok: true, model_id: m.modelId, checks: m.checks, warnings: m.warnings }, null, 2));
    } else {
      for (const c of m.checks) io.out(`  ok    ${c.n}/9 ${c.id.padEnd(19)} ${c.title}`);
      for (const w of m.warnings) io.out(`  warn  ${w}`);
      io.out(`ok: ${m.manifest.name}  model_id ${m.modelId}`);
    }
    m.dispose();
    return 0;
  } catch (e) {
    if (!(e instanceof ModelPackageError)) throw e;
    if (p.values.json) {
      io.out(JSON.stringify({ ok: false, check: e.check, check_number: e.checkNumber, details: e.details }, null, 2));
    } else {
      for (const c of CHECKS) if (c.n < e.checkNumber) io.out(`  ok    ${c.n}/9 ${c.id.padEnd(19)} ${c.title}`);
      io.err(`  FAIL  ${e.checkNumber}/9 ${e.check}`);
      for (const d of e.details) io.err(`        ${d}`);
      io.err(`gp: model package check failed: ${e.check} (${e.checkNumber}/9)`);
    }
    return 1;
  }
}

// ------------------------------------------------------ lineage, ledger

function printLineage(io: Io, n: LineageNode, indent = ""): void {
  const by = n.producedBy ? `${n.producedBy.stage_id} (${n.producedBy.impl}, ${n.producedBy.run_id})` : "external input";
  io.out(`${indent}${shortId(n.id)}  ${n.type}  <- ${by}`);
  for (const i of n.inputs) {
    io.out(`${indent}  via port "${i.port}":`);
    printLineage(io, i.node, `${indent}    `);
  }
}

function lineageCommand(p: Parsed, io: Io): number {
  const store = new ArtifactStore(dataPaths(dataDirOf(p, io)).artifacts);
  printLineage(io, lineageOf(store, store.resolve(positional(p, 0, "artifact-id"))));
  return 0;
}

function ledgerCommand(p: Parsed, io: Io): number {
  const ledger = new Ledger(dataPaths(dataDirOf(p, io)).ledger, budgetOf(p, io));
  const entries = ledger.entries();
  const byStage = new Map<string, number>();
  for (const e of entries) {
    if (e.event === "commit") byStage.set(e.stage_id ?? "?", (byStage.get(e.stage_id ?? "?") ?? 0) + e.cost_usd);
  }
  io.out(`ledger ${ledger.path}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
  io.out(`spent/reserved $${ledger.spentUSD().toFixed(4)}  cap $${ledger.capUSD.toFixed(2)}  remaining $${ledger.remainingUSD().toFixed(4)}`);
  for (const [stage, usd] of byStage) io.out(`  ${stage.padEnd(16)} $${usd.toFixed(4)} committed`);
  const rejected = entries.filter((e) => e.event === "reject").length;
  if (rejected > 0) io.out(`  ${rejected} reservation(s) rejected by the cap`);
  return 0;
}
