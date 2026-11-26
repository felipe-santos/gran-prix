#!/usr/bin/env node
// gp-corpus: frame | walk | report | split | urls   (see README.md)
import { parseArgs } from "node:util";
import { DEFAULT_DATA_DIR } from "./config.mjs";

const USAGE = `usage: gp-corpus <command> [--data-dir DIR]
  frame               fetch the WCXB + WebMainBench URL lists and write frame.jsonl
  walk [--category C] [--limit N] [--no-spa-fallback]
                      walk the frame in hash order and collect accepted pages (resumable)
  report              first20-exclusions.md, urls.csv and the summary
  split               hash-bucket split check (salt gp-dom-v0-s{i})
  revisit [--match RE]  re-evaluate the candidates excluded as "capture" by a since-fixed collector defect
  lock                write corpus-v0.lock.json (sha256 of the frozen files, counts, domains, probe version, seed) and print its sha256
  verify-lock [--lock NAME]
                      recompute the hashes of the latest lock (or of NAME, e.g. corpus-v0.lock.json, from archive/ once superseded); exit 1 if anything changed
  review-page         write review.html, the local page where the owner checks the corpus by eye
  apply-review <export.json> [--check]
                      apply the owner's review by rule: exclude, replace by the next in hash order, write review-applied.md and the next lock
                      (corpus-v0.1.lock.json). --check validates and prints the plan, writes nothing
  diff                attempt-diff.md: pages whose destination changed vs <data-dir>/attempt-1
  import-captures <dir> --out <set-dir>
                      SnapshotSet of the stratum logged_in from the files of tools/capture-extension (nothing is written unless all are valid)
default data dir: ${DEFAULT_DATA_DIR}`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "data-dir": { type: "string", default: DEFAULT_DATA_DIR },
    category: { type: "string" },
    limit: { type: "string" },
    out: { type: "string" },
    "no-spa-fallback": { type: "boolean", default: false },
    match: { type: "string" },
    lock: { type: "string" },
    check: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
const cmd = positionals[0];
const dataDir = values["data-dir"];

if (values.help || cmd === undefined) {
  console.log(USAGE);
  process.exit(cmd === undefined && !values.help ? 2 : 0);
}

switch (cmd) {
  case "frame": {
    const { fetchWcxbIndex, fetchWmbIndex, buildFrame, writeFrame } = await import("./frame.mjs");
    const wcxb = await fetchWcxbIndex(dataDir);
    const wmb = await fetchWmbIndex(dataDir);
    const { rows, stats } = buildFrame(wcxb.rows, wmb.rows);
    stats.downloaded_bytes_this_run = { wcxb: wcxb.downloadedBytes, wmb: wmb.downloadedBytes };
    await writeFrame(dataDir, rows, stats);
    console.log(JSON.stringify(stats, null, 2));
    break;
  }
  case "walk": {
    const { walk } = await import("./walk.mjs");
    await walk(dataDir, { category: values.category, limit: values.limit ? Number(values.limit) : undefined, spaFallback: !values["no-spa-fallback"] });
    break;
  }
  case "report": {
    const { report } = await import("./report.mjs");
    await report(dataDir);
    break;
  }
  case "split": {
    const { splitCheck } = await import("./split.mjs");
    await splitCheck(dataDir);
    break;
  }
  case "revisit": {
    const { revisit } = await import("./walk.mjs");
    await revisit(dataDir, new RegExp(values.match ?? "TrustedScript|is not iterable|is not a function"));
    break;
  }
  case "lock": {
    const { createLock, listLocks } = await import("./lock.mjs");
    if (listLocks(dataDir).length > 1) {
      console.error("the lock chain already has a review lock (corpus-v0.1...): rewriting corpus-v0.lock.json would break it; use verify-lock --lock corpus-v0.lock.json to check the frozen v0");
      process.exit(1);
    }
    const { PROBE_VERSION } = await import("@gran-prix/features");
    const { lock, lock_sha256 } = await createLock(dataDir, { probeVersion: PROBE_VERSION });
    console.log(JSON.stringify({ lock_sha256, created_at: lock.created_at, code_commit: lock.code_commit, probe_version: lock.probe_version, total_accepted: lock.total_accepted, counts: lock.counts, files: lock.files }, null, 2));
    break;
  }
  case "verify-lock": {
    const { verifyLock } = await import("./lock.mjs");
    const problems = verifyLock(dataDir, { lockName: values.lock });
    if (problems.length > 0) {
      console.error(`LOCK MISMATCH (${problems.length}):\n- ${problems.join("\n- ")}`);
      process.exit(1);
    }
    console.log("lock OK: the corpus is exactly what was frozen");
    break;
  }
  case "review-page": {
    const { reviewPage } = await import("./review-page.mjs");
    await reviewPage(dataDir);
    break;
  }
  case "apply-review": {
    const file = positionals[1];
    if (!file) {
      console.error("uso: gp-corpus apply-review <export.json> [--check] [--data-dir DIR]");
      process.exit(2);
    }
    const { applyReview } = await import("./apply-review.mjs");
    const { PROBE_VERSION } = await import("@gran-prix/features");
    try {
      const res = await applyReview(dataDir, file, { probeVersion: PROBE_VERSION, check: values.check });
      console.log(JSON.stringify(res, null, 2));
    } catch (e) {
      console.error(String(e?.message ?? e));
      process.exit(1);
    }
    break;
  }
  case "diff": {
    const { attemptDiff } = await import("./attempt-diff.mjs");
    await attemptDiff(dataDir);
    break;
  }
  case "import-captures": {
    const inDir = positionals[1];
    if (!inDir || !values.out) {
      console.error("uso: gp-corpus import-captures <pasta-com-os-arquivos> --out <pasta-do-conjunto>   (ex.: --out data/corpus/logged-in/)");
      process.exit(2);
    }
    const { runImportCaptures } = await import("./import-captures.mjs");
    process.exit(await runImportCaptures(inDir, values.out));
  }
  default:
    console.error(USAGE);
    process.exit(2);
}
