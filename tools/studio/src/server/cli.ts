import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { userInfo } from "node:os";
import { isMode, type Mode } from "../core/types.js";
import { startStudio, type RunningStudio } from "./app.js";
import { ANNOTATOR_RE } from "./human-store.js";
import { loadQueues, queuesDir } from "./queues.js";
import { listPages } from "./snapshot-set.js";

export const USAGE = `gp-studio: local label review UI (nothing leaves this machine)

usage:
  gp-studio --data-dir <dir> [--annotator <name>] [--port <n>] [--default-mode blind|review] [--guide <file>] [--fixtures-dir <dir>] [--queues-dir <dir>]

  --data-dir        gp data dir whose artifact store holds the SnapshotSet(s) to label (default: data)
  --annotator       who is labeling; labels go to <data-dir>/human-labels/<annotator>/ (default: your login name)
  --port            port on 127.0.0.1 (default: a free one)
  --default-mode    mode of pages not opened yet: blind (default, no draft ever shown) or review
  --guide           annotation guide to serve as text for the quick-reference link (optional)
  --fixtures-dir    fixtures/pages of the repository, for the calibration exercise (default: the one of this checkout)
  --queues-dir      directory of the label queues <task>.json (default: <data-dir>/labeling/queues)

exit status: 0 ok, 2 usage error`;

export class UsageError extends Error {}

function login(): string {
  try {
    return userInfo().username;
  } catch {
    return "annotator";
  }
}

export interface ParsedArgs {
  dataDir: string;
  annotator: string;
  port: number;
  defaultMode: Mode;
  guidePath?: string;
  fixturesDir?: string;
  queuesDir?: string;
  help: boolean;
}

export function parseCli(argv: string[], cwd: string): ParsedArgs {
  let v;
  try {
    v = parseArgs({
      args: argv,
      options: {
        "data-dir": { type: "string" },
        annotator: { type: "string" },
        port: { type: "string" },
        "default-mode": { type: "string" },
        guide: { type: "string" },
        "fixtures-dir": { type: "string" },
        "queues-dir": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    }).values;
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const annotator = v.annotator ?? login().replace(/[^A-Za-z0-9._-]/g, "_");
  if (!ANNOTATOR_RE.test(annotator)) throw new UsageError(`--annotator ${JSON.stringify(annotator)}: letters, digits, . _ - only, at most 48 characters, starting with a letter or digit`);
  const port = v.port === undefined ? 0 : Number(v.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--port must be an integer between 0 and 65535 (got ${v.port})`);
  const mode = v["default-mode"] ?? "blind";
  if (!isMode(mode)) throw new UsageError('--default-mode must be "blind" or "review"');
  return {
    dataDir: resolve(cwd, v["data-dir"] ?? "data"),
    annotator,
    port,
    defaultMode: mode,
    ...(v.guide !== undefined ? { guidePath: resolve(cwd, v.guide) } : {}),
    ...(v["fixtures-dir"] !== undefined ? { fixturesDir: resolve(cwd, v["fixtures-dir"]) } : {}),
    ...(v["queues-dir"] !== undefined ? { queuesDir: resolve(cwd, v["queues-dir"]) } : {}),
    help: v.help === true,
  };
}

/** Entry point of `gp-studio`; resolves with the running server (the process then stays alive until killed). */
export async function main(argv: string[], io: { out(l: string): void; err(l: string): void; cwd: string }): Promise<RunningStudio | number> {
  let args: ParsedArgs;
  try {
    args = parseCli(argv, io.cwd);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.err(`gp-studio: ${e.message}`);
    io.err(USAGE);
    return 2;
  }
  if (args.help) {
    io.out(USAGE);
    return 0;
  }
  if (!existsSync(args.dataDir)) {
    io.err(`gp-studio: data dir ${args.dataDir} does not exist (run \`gp run\` with a collect stage first)`);
    return 2;
  }
  if (args.guidePath !== undefined && !existsSync(args.guidePath)) {
    io.err(`gp-studio: guide file ${args.guidePath} does not exist`);
    return 2;
  }
  const n = listPages(args.dataDir).length;
  const studio = await startStudio({
    dataDir: args.dataDir,
    annotator: args.annotator,
    port: args.port,
    defaultMode: args.defaultMode,
    ...(args.guidePath !== undefined ? { guidePath: args.guidePath } : {}),
    ...(args.fixturesDir !== undefined ? { fixturesDir: args.fixturesDir } : {}),
    ...(args.queuesDir !== undefined ? { queuesDir: args.queuesDir } : {}),
  });
  const q = loadQueues(args.queuesDir ?? queuesDir(args.dataDir));
  io.out(`gp-studio: ${q.queues.length} label queue(s)${q.invalid.length > 0 ? `, ${q.invalid.length} refused (${q.invalid.map((i) => i.file).join(", ")})` : ""} in ${args.queuesDir ?? queuesDir(args.dataDir)}`);
  io.out(`gp-studio: ${n} page(s) in ${args.dataDir}${n === 0 ? " (no SnapshotSet found: collect pages first)" : ""}`);
  io.out(`gp-studio: annotator "${args.annotator}", default mode ${args.defaultMode}; labels go to ${args.dataDir}/human-labels/${args.annotator}/`);
  io.out(`gp-studio: listening on 127.0.0.1 only. Open this URL (the token is the key, keep it private):`);
  io.out(`  ${studio.url}`);
  return studio;
}
