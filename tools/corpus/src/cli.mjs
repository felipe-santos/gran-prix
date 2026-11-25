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
  diff                attempt-diff.md: pages whose destination changed vs <data-dir>/attempt-1
default data dir: ${DEFAULT_DATA_DIR}`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "data-dir": { type: "string", default: DEFAULT_DATA_DIR },
    category: { type: "string" },
    limit: { type: "string" },
    "no-spa-fallback": { type: "boolean", default: false },
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
  case "diff": {
    const { attemptDiff } = await import("./attempt-diff.mjs");
    await attemptDiff(dataDir);
    break;
  }
  default:
    console.error(USAGE);
    process.exit(2);
}
