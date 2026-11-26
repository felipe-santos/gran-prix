// corpus-v0.lock.json: a verifiable freeze of the corpus. The lock lives in the (gitignored) data dir; its own sha256 is
// published by the coordinator. `verify-lock` recomputes every hash and fails when anything changed.
// `apply-review` writes the next lock of the chain (`corpus-v0.1.lock.json`, ...) with `supersedes` and the sha256 of the owner's
// review export; the lock it supersedes is never deleted, and the files it froze (those `apply-review` rewrites) are kept in
// `archive/<lock name>/` so the older lock can still be verified.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, ORDER_PREFIX, SEED } from "./config.mjs";
import { readJsonlSync } from "./jsonl.mjs";
import { effectiveRecords } from "./state.mjs";

export const LOCK_NAME = "corpus-v0.lock.json";
export const LOCK_FORMAT = "gran-prix.corpus-lock/1";
/** Files whose bytes are frozen (paths relative to the data dir). */
export const LOCKED_FILES = ["frame.jsonl", "walked.jsonl", "exclusions.jsonl", "urls.csv", "snapshot-set/manifest.json"];
/** Where the files a later lock rewrites are kept, per superseded lock. */
export const ARCHIVE_DIR = "archive";

export const sha256File = (path) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

function gitHead() {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** The locks of the chain, oldest first: `corpus-v0.lock.json` (n = 0), `corpus-v0.1.lock.json` (n = 1), ... */
export function listLocks(dataDir) {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .map((name) => ({ name, m: /^corpus-v0(?:\.(\d+))?\.lock\.json$/.exec(name) }))
    .filter((x) => x.m)
    .map((x) => ({ name: x.name, n: x.m[1] === undefined ? 0 : Number(x.m[1]), path: join(dataDir, x.name) }))
    .sort((a, b) => a.n - b.n);
}
export const latestLock = (dataDir) => listLocks(dataDir).at(-1) ?? null;
export const lockNameOf = (n) => (n === 0 ? LOCK_NAME : `corpus-v0.${n}.lock.json`);
export const archiveDirOf = (dataDir, lockName) => join(dataDir, ARCHIVE_DIR, basename(lockName, ".lock.json"));

/** Counts, domains and snapshot-probe versions, all derived from the frozen files (a pure function of the data dir). */
export function describeCorpus(dataDir, { walkedPath = join(dataDir, "walked.jsonl") } = {}) {
  const accepted = effectiveRecords(readJsonlSync(walkedPath)).filter((r) => r.outcome === "accepted");
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

/**
 * `extraFiles` (relative paths, e.g. the review export and review-applied.md) are frozen too; `extra` adds fields to the lock
 * (`supersedes`, `review`).
 */
export async function createLock(dataDir, { probeVersion, commit = gitHead(), now = new Date(), name = LOCK_NAME, extraFiles = [], extra = {} } = {}) {
  const files = {};
  for (const f of [...LOCKED_FILES, ...extraFiles]) files[f] = sha256File(join(dataDir, f));
  const d = describeCorpus(dataDir);
  const lock = {
    format: LOCK_FORMAT,
    created_at: now.toISOString(),
    code_commit: commit,
    probe_version: probeVersion,
    seed: SEED,
    order_prefix: ORDER_PREFIX,
    ...extra,
    files,
    counts: d.counts,
    total_accepted: d.total_accepted,
    snapshot_probe_versions: d.snapshot_probe_versions,
    domains: d.domains,
  };
  await writeFile(join(dataDir, name), `${JSON.stringify(lock, null, 2)}\n`);
  return { lock, lock_sha256: sha256File(join(dataDir, name)) };
}

/**
 * Recomputes everything the lock records. Returns the list of problems (empty = the corpus is exactly what was frozen).
 * `lockName` defaults to the latest lock of the chain. A superseded lock (or `fromArchive: true`) reads the files `apply-review`
 * archived in `archive/<lock name>/` when they exist, and the live files otherwise.
 */
export function verifyLock(dataDir, { lockName, fromArchive } = {}) {
  const problems = [];
  const name = lockName ?? latestLock(dataDir)?.name ?? LOCK_NAME;
  const lockPath = join(dataDir, name);
  if (!existsSync(lockPath)) return [`${name} not found in ${dataDir}`];
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const chain = listLocks(dataDir);
  const mine = chain.find((x) => x.name === name);
  const superseded = mine !== undefined && chain.some((l) => l.n > mine.n);
  const arch = (fromArchive ?? superseded) ? archiveDirOf(dataDir, name) : null;
  const where = (f) => (arch && existsSync(join(arch, f)) ? join(arch, f) : join(dataDir, f));
  if (lock.format !== LOCK_FORMAT) problems.push(`unknown lock format ${lock.format}`);
  for (const [f, want] of Object.entries(lock.files ?? {})) {
    const p = where(f);
    if (!existsSync(p)) problems.push(`${f}: missing`);
    else if (sha256File(p) !== want) problems.push(`${f}: sha256 changed (${sha256File(p)} != ${want})`);
  }
  for (const f of LOCKED_FILES) if (!(f in (lock.files ?? {}))) problems.push(`${f}: not recorded in the lock`);
  if (problems.length === 0) {
    const d = describeCorpus(dataDir, { walkedPath: where("walked.jsonl") });
    if (JSON.stringify(d.counts) !== JSON.stringify(lock.counts)) problems.push("per-category counts differ from the lock");
    if (JSON.stringify(d.domains) !== JSON.stringify(lock.domains)) problems.push("domain lists differ from the lock");
    if (JSON.stringify(d.snapshot_probe_versions) !== JSON.stringify(lock.snapshot_probe_versions)) problems.push("snapshot probe versions differ from the lock");
    if (d.snapshot_probe_versions.includes("MISSING")) problems.push("a snapshot file of the manifest is missing");
    if (lock.seed !== SEED || lock.order_prefix !== ORDER_PREFIX) problems.push("seed or order prefix differ from the protocol constants");
  }
  return problems;
}
