// corpus-v0.lock.json: a verifiable freeze of the corpus. The lock lives in the (gitignored) data dir; its own sha256 is
// published by the coordinator. `verify-lock` recomputes every hash and fails when anything changed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, ORDER_PREFIX, SEED } from "./config.mjs";
import { readJsonlSync } from "./jsonl.mjs";
import { effectiveRecords } from "./state.mjs";

export const LOCK_NAME = "corpus-v0.lock.json";
export const LOCK_FORMAT = "gran-prix.corpus-lock/1";
/** Files whose bytes are frozen (paths relative to the data dir). */
export const LOCKED_FILES = ["frame.jsonl", "walked.jsonl", "exclusions.jsonl", "urls.csv", "snapshot-set/manifest.json"];

export const sha256File = (path) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

function gitHead() {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Counts, domains and snapshot-probe versions, all derived from the frozen files (a pure function of the data dir). */
export function describeCorpus(dataDir) {
  const accepted = effectiveRecords(readJsonlSync(join(dataDir, "walked.jsonl"))).filter((r) => r.outcome === "accepted");
  const counts = {};
  const domains = {};
  for (const c of CATEGORIES) {
    const rows = accepted.filter((r) => r.category === c.name);
    counts[c.name] = { target: c.n, accepted: rows.length };
    domains[c.name] = [...new Set(rows.map((r) => r.detail.group_key))].sort();
  }
  const probeVersions = new Set();
  for (const r of accepted) {
    const p = join(dataDir, "snapshot-set", r.set_entry.snapshot);
    if (existsSync(p)) probeVersions.add(JSON.parse(readFileSync(p, "utf8")).probe?.version ?? "?");
    else probeVersions.add("MISSING");
  }
  return { counts, domains, total_accepted: accepted.length, snapshot_probe_versions: [...probeVersions].sort() };
}

export async function createLock(dataDir, { probeVersion, commit = gitHead(), now = new Date() } = {}) {
  const files = {};
  for (const f of LOCKED_FILES) files[f] = sha256File(join(dataDir, f));
  const d = describeCorpus(dataDir);
  const lock = {
    format: LOCK_FORMAT,
    created_at: now.toISOString(),
    code_commit: commit,
    probe_version: probeVersion,
    seed: SEED,
    order_prefix: ORDER_PREFIX,
    files,
    counts: d.counts,
    total_accepted: d.total_accepted,
    snapshot_probe_versions: d.snapshot_probe_versions,
    domains: d.domains,
  };
  await writeFile(join(dataDir, LOCK_NAME), `${JSON.stringify(lock, null, 2)}\n`);
  return { lock, lock_sha256: sha256File(join(dataDir, LOCK_NAME)) };
}

/** Recomputes everything the lock records. Returns the list of problems (empty = the corpus is exactly what was frozen). */
export function verifyLock(dataDir) {
  const problems = [];
  const lockPath = join(dataDir, LOCK_NAME);
  if (!existsSync(lockPath)) return [`${LOCK_NAME} not found in ${dataDir}`];
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (lock.format !== LOCK_FORMAT) problems.push(`unknown lock format ${lock.format}`);
  for (const [f, want] of Object.entries(lock.files ?? {})) {
    const p = join(dataDir, f);
    if (!existsSync(p)) problems.push(`${f}: missing`);
    else if (sha256File(p) !== want) problems.push(`${f}: sha256 changed (${sha256File(p)} != ${want})`);
  }
  for (const f of LOCKED_FILES) if (!(f in (lock.files ?? {}))) problems.push(`${f}: not recorded in the lock`);
  if (problems.length === 0) {
    const d = describeCorpus(dataDir);
    if (JSON.stringify(d.counts) !== JSON.stringify(lock.counts)) problems.push("per-category counts differ from the lock");
    if (JSON.stringify(d.domains) !== JSON.stringify(lock.domains)) problems.push("domain lists differ from the lock");
    if (JSON.stringify(d.snapshot_probe_versions) !== JSON.stringify(lock.snapshot_probe_versions)) problems.push("snapshot probe versions differ from the lock");
    if (d.snapshot_probe_versions.includes("MISSING")) problems.push("a snapshot file of the manifest is missing");
    if (lock.seed !== SEED || lock.order_prefix !== ORDER_PREFIX) problems.push("seed or order prefix differ from the protocol constants");
  }
  return problems;
}
