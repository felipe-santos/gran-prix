import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Of, type Sha256 } from "@gran-prix/contracts";

/**
 * Trafilatura runs in a Python sidecar (`tools/baselines/python/traf_sidecar.py`): one process per batch of pages,
 * JSON on stdin/stdout. Python and its packages are NEVER installed system-wide: the packages live in
 * `tools/baselines/.pylibs` (`pip install --target`, pinned by `tools/baselines/requirements.txt`).
 *
 * Environment: `GP_PYTHON` (interpreter, default `python3`), `GP_BASELINES_PYLIBS` (directory put on PYTHONPATH,
 * default `tools/baselines/.pylibs`).
 */

const BASELINES = fileURLToPath(new URL("../../../../baselines/", import.meta.url));
export const SIDECAR_SCRIPT = `${BASELINES}python/traf_sidecar.py`;
export const DEFAULT_PYLIBS = `${BASELINES}.pylibs`;
export const SETUP_HINT = "install it with: pip install --target tools/baselines/.pylibs -r tools/baselines/requirements.txt";

export type TrafilaturaMode = "precision" | "default" | "recall";

export interface TrafilaturaOptions {
  mode?: TrafilaturaMode;
  include_tables?: boolean;
  include_comments?: boolean;
  include_links?: boolean;
  include_images?: boolean;
  deduplicate?: boolean;
  no_fallback?: boolean;
}

export interface SidecarDoc {
  key: string;
  html: string;
  url: string | null;
}

export interface SidecarResult {
  key: string;
  text: string | null;
  error: string | null;
}

function env(): NodeJS.ProcessEnv {
  const libs = process.env["GP_BASELINES_PYLIBS"] ?? DEFAULT_PYLIBS;
  const prev = process.env["PYTHONPATH"];
  return { ...process.env, PYTHONPATH: prev ? `${libs}${delimiter}${prev}` : libs, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" };
}

function call(args: string[], input?: string): string {
  const python = process.env["GP_PYTHON"] ?? "python3";
  const p = spawnSync(python, [SIDECAR_SCRIPT, ...args], { input, env: env(), encoding: "utf8", maxBuffer: 1 << 30 });
  if (p.error) throw new Error(`cannot run ${python}: ${p.error.message}`);
  if (p.status !== 0) {
    const tail = (p.stderr ?? "").trim().split("\n").slice(-3).join(" | ");
    throw new Error(`the Trafilatura sidecar failed (exit ${p.status}): ${tail}${/No module named/.test(tail) ? `; ${SETUP_HINT}` : ""}`);
  }
  return p.stdout;
}

let versionCache: string | undefined;

/** Installed Trafilatura version (spawns the sidecar once per process). */
export function trafilaturaVersion(): string {
  versionCache ??= (JSON.parse(call(["--version"])) as { trafilatura: string }).trafilatura;
  return versionCache;
}

/** Digest of the tool the labels depend on: the Trafilatura version and the sidecar source. Goes into the stage cache key. */
export function sidecarDigest(): Sha256 {
  if (!existsSync(SIDECAR_SCRIPT)) throw new Error(`sidecar not found at ${SIDECAR_SCRIPT}`);
  return sha256Of(`trafilatura@${trafilaturaVersion()}\n${readFileSync(SIDECAR_SCRIPT, "utf8")}`);
}

export interface SidecarRun {
  version: string;
  /** Options as the sidecar applied them (defaults filled in). */
  options: Required<TrafilaturaOptions>;
  results: SidecarResult[];
}

/** Extracts the text of every doc with Trafilatura (`output_format="txt"`). Results come back in input order. */
export function runTrafilatura(docs: readonly SidecarDoc[], options: TrafilaturaOptions = {}): SidecarRun {
  if (docs.length === 0) return { version: trafilaturaVersion(), options: JSON.parse(call([], JSON.stringify({ options, docs: [] }))).options, results: [] };
  return JSON.parse(call([], JSON.stringify({ options, docs }))) as SidecarRun;
}
