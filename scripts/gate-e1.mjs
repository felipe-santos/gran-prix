#!/usr/bin/env node
/**
 * Gate E1: `gp run pipelines/dom-v0.json` is reproducible and the produced model has runtime parity.
 *
 *   node scripts/gate-e1.mjs [--rebuild] [--no-build] [--keep] [--work-dir DIR] [--pipeline FILE]
 *
 * 1. Prerequisites: the WASM build, the `gp-train` binary, the JS packages (`tools/cli/dist` and the packages it
 *    imports) and a cached Chromium. A missing or stale piece is built (`--rebuild` rebuilds all; `--no-build` only
 *    checks and fails with the command to run).
 * 2. `gp validate` on the pipeline.
 * 3. `gp run` TWICE, into two fresh data dirs with different run ids. Every output artifact id of every stage must be
 *    identical across the two data dirs (and so must the cache keys).
 * 4. A second run in the SAME data dir must be a 100% cache hit.
 * 5. Runtime parity of the model the pipeline produced:
 *      - `gp model check --runtime ts` and `--runtime wasm`: 9/9 each;
 *      - the package bundle's self-test (`node selftest.mjs` in the bundle) passes, and `bundle.json` records it;
 *      - (the gp-train binary is copied once at the start, so a concurrent cargo build cannot change it mid-gate)
 *      - the Rust side: `gp-train eval --with-scores` (it loads the package through the Rust runtime, which verifies
 *        the digests and the model_id) reproduces every case of `golden.json` within its tolerance.
 * 6. Post-step of the pipeline: `gp report` renders the evaluate output to HTML.
 *
 * Prints a PASS/FAIL table and exits 1 on FAIL (2 on a setup problem).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const REBUILD = flag("--rebuild");
const NO_BUILD = flag("--no-build");
const KEEP = flag("--keep");
const PIPELINE = resolve(ROOT, opt("--pipeline", "pipelines/dom-v0.json"));

const GP = join(ROOT, "tools/cli/dist/bin.js");
const log = (m) => process.stderr.write(`${m}\n`);
const results = []; // { name, ok, detail }
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  return ok;
};

function sh(cmd, argv, o = {}) {
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: process.env, ...o });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}
const gp = (argv, o) => sh(process.execPath, [GP, ...argv], o);
const fail = (msg) => {
  log(`\ngate-e1: ${msg}`);
  process.exit(2);
};

// ------------------------------------------------------------------ prerequisites

/** Newest mtime of the files with these extensions under `dir` (0 when it does not exist). */
function newest(dir, exts) {
  let m = 0;
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "dist" && e.name !== "target") walk(p);
      } else if (exts.some((x) => e.name.endsWith(x))) m = Math.max(m, statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return m;
}
const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);

const JS_PACKAGES = ["contracts", "model", "infer-ts", "labels", "features", "report"].map((p) => `packages/${p}`).concat("tools/cli");
const jsStale = () =>
  JS_PACKAGES.some((p) => {
    const out = mtime(join(ROOT, p, "dist/index.js"));
    return out === 0 || newest(join(ROOT, p, "src"), [".ts", ".json"]) > out;
  }) || !existsSync(join(ROOT, "packages/features/dist/gp-features.iife.js"));

const WASM_OUT = join(ROOT, "packages/wasm/dist/node/gran_prix_wasm_bg.wasm");
const wasmStale = () => mtime(WASM_OUT) === 0 || Math.max(newest(join(ROOT, "gran-prix-wasm/src"), [".rs"]), mtime(join(ROOT, "gran-prix-wasm/Cargo.toml"))) > mtime(WASM_OUT);

function gpTrainBin() {
  if (process.env.GP_TRAIN_BIN) return process.env.GP_TRAIN_BIN;
  const t = process.env.CARGO_TARGET_DIR;
  return join(t ? resolve(ROOT, t) : join(ROOT, "target"), "release", "gp-train");
}

function chromium() {
  if (process.env.GP_CHROMIUM) return existsSync(process.env.GP_CHROMIUM) ? process.env.GP_CHROMIUM : undefined;
  const base = join(homedir(), ".cache/ms-playwright");
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base).filter((n) => n.startsWith("chromium-") && !n.includes("headless")).sort().reverse()) {
    const exe = join(base, d, "chrome-linux64/chrome");
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

function step(name, needed, cmd, argv) {
  if (!REBUILD && !needed()) return log(`  have ${name}`);
  const line = `${cmd} ${argv.join(" ")}`;
  if (NO_BUILD) fail(`${name} is missing or stale; build it first:\n  ${line}`);
  log(`  build ${name}: ${line}`);
  const r = sh(cmd, argv, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) fail(`building ${name} failed (${line})`);
}

log("gate-e1: prerequisites");
step("WASM (@gran-prix/wasm)", wasmStale, process.execPath, ["scripts/build-wasm.mjs", "--target", "both", "--web-out", "packages/wasm/dist/web", "--node-out", "packages/wasm/dist/node"]);
// cargo is incremental: a no-op when the binary is current, and the only way to know it is not stale.
step("gp-train", () => true, "cargo", ["build", "--release", "-p", "gp-train"]);
step("JS packages (contracts, model, infer-ts, labels, features, report, cli)", jsStale, "pnpm", ["--filter", "@gran-prix/cli...", "build"]);
if (!existsSync(gpTrainBin())) fail(`gp-train not found at ${gpTrainBin()} (set GP_TRAIN_BIN or CARGO_TARGET_DIR)`);
if (!chromium()) fail("no cached Chromium (set GP_CHROMIUM, or: pnpm exec playwright install chromium)");

// ------------------------------------------------------------------ runs

const work = opt("--work-dir") ? resolve(opt("--work-dir")) : mkdtempSync(join(tmpdir(), "gate-e1-"));
// The trainer binary lives in a target dir that other builds (another checkout, another cargo run) may overwrite
// while the gate runs; pin one copy, so both runs and the Rust-side check use the very same bytes.
mkdirSync(join(work, "bin"), { recursive: true });
const pinned = join(work, "bin", "gp-train");
copyFileSync(gpTrainBin(), pinned);
process.env.GP_TRAIN_BIN = pinned;
const dirA = join(work, "data-a");
const dirB = join(work, "data-b");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const rel = (id) => id.replace(":", "-");

function run(dataDir, runId) {
  const t0 = Date.now();
  const r = gp(["run", PIPELINE, "--data-dir", dataDir, "--run-id", runId, "--root", ROOT]);
  const dir = join(dataDir, "runs", runId);
  const summary = existsSync(join(dir, "run.json")) ? readJson(join(dir, "run.json")) : undefined;
  return { ...r, summary, secs: ((Date.now() - t0) / 1000).toFixed(1), dir };
}

const portIds = (stage) => Object.fromEntries(Object.entries(stage.outputs ?? {}));

log("\ngate-e1: gp validate");
const v = gp(["validate", PIPELINE]);
check("gp validate pipelines/dom-v0.json", v.status === 0, v.status === 0 ? v.stdout.trim().split("\n")[0] : (v.stderr || v.stdout).trim().slice(0, 300));

log("\ngate-e1: run A (fresh data dir A, run id gate-a)");
const A = run(dirA, "gate-a");
check("run A succeeds", A.status === 0 && A.summary?.ok === true, A.status === 0 ? `${A.secs}s` : (A.stderr || A.stdout).trim().split("\n").slice(-6).join(" | "));
log("gate-e1: run B (fresh data dir B, run id gate-b)");
const B = run(dirB, "gate-b");
check("run B succeeds", B.status === 0 && B.summary?.ok === true, B.status === 0 ? `${B.secs}s` : (B.stderr || B.stdout).trim().split("\n").slice(-6).join(" | "));

/** @type {Array<{stage:string, port:string, a:string, b:string}>} */
const idRows = [];
if (A.summary && B.summary) {
  const bById = new Map(B.summary.stages.map((s) => [s.stage_id, s]));
  for (const sa of A.summary.stages) {
    const sb = bById.get(sa.stage_id);
    const oa = portIds(sa);
    const ob = sb ? portIds(sb) : {};
    for (const port of [...new Set([...Object.keys(oa), ...Object.keys(ob)])].sort()) {
      idRows.push({ stage: sa.stage_id, port, a: JSON.stringify(oa[port] ?? null), b: JSON.stringify(ob[port] ?? null) });
    }
    idRows.push({ stage: sa.stage_id, port: "(cache key)", a: sa.cache_key ?? "-", b: sb?.cache_key ?? "-" });
  }
}
const mismatched = idRows.filter((r) => r.a !== r.b || r.a === "null");
check(
  "every stage output id (and cache key) is identical across data dirs A and B",
  idRows.length > 0 && mismatched.length === 0,
  `${idRows.length - mismatched.length}/${idRows.length} identical${mismatched.length ? `; differ: ${[...new Set(mismatched.map((m) => `${m.stage}.${m.port}`))].join(", ")}` : ""}`,
);
check("run ids differ and so do the data dirs", A.summary?.run_id !== B.summary?.run_id && dirA !== dirB, `${A.summary?.run_id} / ${B.summary?.run_id}`);

log("\ngate-e1: second run in data dir A (run id gate-a-again)");
const A2 = run(dirA, "gate-a-again");
const n = A2.summary?.stages.length ?? 0;
const cached = A2.summary?.counts?.cached ?? 0;
check("second run in the same data dir is a 100% cache hit", A2.status === 0 && n > 0 && cached === n && (A2.summary?.counts?.ran ?? 1) === 0, `${cached}/${n} stages cached, ${A2.summary?.counts?.ran ?? "?"} ran`);
const sameIds = A.summary && A2.summary && A.summary.stages.every((s, i) => JSON.stringify(s.outputs) === JSON.stringify(A2.summary.stages[i]?.outputs));
check("the cached run reports the same output ids as run A", sameIds === true);

// ------------------------------------------------------------------ runtime parity

log("\ngate-e1: runtime parity of the produced model");
const outOf = (summary, stage, port) => summary?.stages.find((s) => s.stage_id === stage)?.outputs?.[port];
const modelId = outOf(A.summary, "train", "model");
const bundleId = outOf(A.summary, "package", "bundle");
const datasetId = outOf(A.summary, "dataset", "dataset");
const reportId = outOf(A.summary, "evaluate", "report");
const extrasId = outOf(A.summary, "evaluate", "extras");
const files = (id) => join(dirA, "artifacts", rel(id), "files");

if (modelId && bundleId && datasetId) {
  const modelDir = files(modelId);
  const modelJson = readJson(join(modelDir, "model.json"));
  for (const runtime of ["ts", "wasm"]) {
    const r = gp(["model", "check", modelDir, "--runtime", runtime, "--json"]);
    let doc;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = undefined;
    }
    const passed = r.status === 0 && doc?.ok === true && Array.isArray(doc.checks) && doc.checks.length === 9;
    check(`gp model check --runtime ${runtime}: 9/9`, passed, passed ? `model_id ${doc.model_id.slice(0, 19)}` : (r.stderr || r.stdout).trim().split("\n").slice(-4).join(" | "));
  }

  const bundleDir = files(bundleId);
  const st = sh(process.execPath, ["selftest.mjs"], { cwd: bundleDir });
  const bundle = readJson(join(bundleDir, "bundle.json"));
  check("package bundle self-test passes (node selftest.mjs, generated TS runtime)", st.status === 0, st.stdout.trim().split("\n").pop());
  check("bundle.json carries the same model_id as the package and records the self-test", bundle.model_id === modelJson.model_id && bundle.self_test?.cases > 0, `${bundle.self_test?.cases} cases`);

  // Rust side: the Rust runtime loads the package (digests, model_id) and must reproduce golden.json on the real rows.
  const golden = readJson(join(modelDir, "golden.json"));
  const tol = golden.tolerance?.abs ?? 1e-5;
  const scores = new Map(); // "<split>/<group>/<unit>" -> score
  let rustOk = true;
  let rustDetail = "";
  for (const split of ["val", "train"]) {
    const out = join(work, `rust-eval-${split}.json`);
    const r = sh(gpTrainBin(), ["eval", "--dataset", files(datasetId), "--model", modelDir, "--split", split, "--out", out, "--with-scores"]);
    if (r.status !== 0) {
      rustOk = false;
      rustDetail = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ");
      break;
    }
    for (const [g, u, , score] of readJson(out).scores) scores.set(`${split}/${g}/${u}`, score);
  }
  let worst = 0;
  let missing = 0;
  if (rustOk) {
    for (const c of golden.cases) {
      const s = scores.get(c.name);
      if (s === undefined) missing++;
      else worst = Math.max(worst, Math.abs(s - c.score[0]));
    }
    rustOk = missing === 0 && worst <= tol && golden.cases.length > 0;
    rustDetail = `${golden.cases.length - missing}/${golden.cases.length} golden cases found, max |score diff| ${worst.toExponential(2)} (tolerance ${tol})`;
  }
  check("Rust runtime (gp-train eval) loads the package and reproduces golden.json", rustOk, rustDetail);
} else {
  check("runtime parity", false, "run A did not produce model, bundle and dataset");
}

log("\ngate-e1: post-step gp report");
if (reportId && extrasId) {
  const html = join(work, "report.html");
  const r = gp(["report", join(files(reportId).replace(/files$/, ""), "content.json"), "--extras", join(files(extrasId).replace(/files$/, ""), "content.json"), "-o", html]);
  const size = existsSync(html) ? statSync(html).size : 0;
  check("gp report renders the evaluate output to one HTML file", r.status === 0 && size > 1000, r.status === 0 ? `${size} bytes` : (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | "));
} else {
  check("gp report", false, "run A did not produce the evaluate report");
}

// ------------------------------------------------------------------ summary

const pad = (s, w) => s + " ".repeat(Math.max(0, w - s.length));
const out = [];
out.push("");
out.push("Stage outputs, data dir A vs data dir B (run ids gate-a / gate-b)");
out.push("-".repeat(100));
for (const r of idRows) {
  const same = r.a === r.b && r.a !== "null";
  const id = (s) => s.replaceAll('"', "");
  out.push(`${same ? "==" : "!="}  ${pad(`${r.stage}.${r.port}`, 26)} ${id(r.a)}${same ? "" : `\n    ${pad("", 26)} ${id(r.b)}`}`);
}
out.push("");
out.push("Gate E1");
out.push("-".repeat(100));
for (const r of results) out.push(`${r.ok ? "PASS" : "FAIL"}  ${pad(r.name, 78)} ${r.detail}`);
const ok = results.every((r) => r.ok);
out.push("-".repeat(100));
out.push(ok ? `GATE E1: PASS (${results.length} checks)` : `GATE E1: FAIL (${results.filter((r) => !r.ok).length} of ${results.length} checks failed; work dir kept: ${work})`);
process.stdout.write(`${out.join("\n")}\n`);
writeFileSync(join(work, "gate-e1.txt"), `${out.join("\n")}\n`);
if (ok && !KEEP && !opt("--work-dir")) rmSync(work, { recursive: true, force: true });
else if (ok) log(`work dir kept: ${work}`);
process.exit(ok ? 0 : 1);
