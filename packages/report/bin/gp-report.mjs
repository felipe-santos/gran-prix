#!/usr/bin/env node
// gp-report <eval-report.json> [-o out.html] [--compare other.json] [--extras extras.json]
// Validates the input with @gran-prix/contracts, then writes ONE self-contained HTML file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: gp-report <eval-report.json> [-o out.html] [--compare other.json] [--extras extras.json]

  <eval-report.json>   an EvalReport (gran-prix.eval-report), validated before rendering
  -o, --out FILE       output file (default: <input name>.report.html in the current directory)
  --compare FILE       a second EvalReport; deltas are shown only if both use the same dataset_id
  --extras FILE        sidecar with CIs, PR-curve points, D1/D2 tokens, gate details, notes (see README)
  -h, --help           this text

exit codes: 0 ok, 1 invalid input, 2 usage error`;

const fail = (code, msg) => {
  process.stderr.write(`gp-report: ${msg}\n`);
  process.exit(code);
};

function parseArgs(argv) {
  const a = { input: undefined, out: undefined, compare: undefined, extras: undefined };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) fail(2, `${t} needs a value\n${USAGE}`);
      return v;
    };
    if (t === "-h" || t === "--help") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (t === "-o" || t === "--out") a.out = value();
    else if (t === "--compare") a.compare = value();
    else if (t === "--extras") a.extras = value();
    else if (t.startsWith("-")) fail(2, `unknown option ${t}\n${USAGE}`);
    else if (a.input === undefined) a.input = t;
    else fail(2, `unexpected argument ${t}\n${USAGE}`);
  }
  if (a.input === undefined) fail(2, `missing <eval-report.json>\n${USAGE}`);
  return a;
}

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    fail(1, `cannot read ${what} ${path}: ${e.code ?? e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(1, `${what} ${path} is not valid JSON: ${e.message}`);
  }
}

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
if (!existsSync(dist)) fail(1, "dist/ is missing: run `pnpm --filter @gran-prix/report build` first");
const { renderReport, ExtrasError } = await import(dist);
const { validate } = await import("@gran-prix/contracts");

function validated(path, what) {
  const r = validate("eval-report", readJson(path, what));
  if (!r.ok) {
    const lines = r.issues.slice(0, 20).map((i) => `  [${i.code}] ${i.path}: ${i.message}`);
    const more = r.issues.length > 20 ? `\n  ... and ${r.issues.length - 20} more` : "";
    fail(1, `${what} ${path} is not a valid EvalReport (${r.issues.length} issue(s)):\n${lines.join("\n")}${more}`);
  }
  return r.value;
}

const args = parseArgs(process.argv.slice(2));
const report = validated(args.input, "input");
const compare = args.compare ? validated(args.compare, "--compare file") : undefined;
const extras = args.extras ? readJson(args.extras, "--extras file") : undefined;

let html;
try {
  html = renderReport(report, { compare, extras });
} catch (e) {
  if (e instanceof ExtrasError) fail(1, `--extras file ${args.extras}: ${e.issues.join("; ")}`);
  throw e;
}
const out = resolve(args.out ?? `${basename(args.input, extname(args.input))}.report.html`);
writeFileSync(out, html);
process.stdout.write(`${out}\n`);
