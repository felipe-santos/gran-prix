import { contractByName, type ContractName } from "../registry.js";
import type { ContractIssue } from "./result.js";

export interface ParsedSemVer {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemVer(v: string): ParsedSemVer | undefined {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(v);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** -1 / 0 / 1 comparing (major, minor, patch). */
export function compareVersions(a: ParsedSemVer, b: ParsedSemVer): number {
  return Math.sign(a.major - b.major) || Math.sign(a.minor - b.minor) || Math.sign(a.patch - b.patch);
}

/**
 * Reader rule of the versioning policy (README):
 *  - wrong `format`                     -> refuse;
 *  - unknown MAJOR (either direction)   -> refuse;
 *  - same MAJOR, newer MINOR/PATCH      -> accept (unknown fields are ignored);
 *  - same MAJOR, older                  -> accept.
 * Malformed documents are left to the schema check, which reports them with a path.
 */
export function checkFormatVersion(name: ContractName, doc: unknown): ContractIssue[] {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return [];
  const c = contractByName(name);
  const d = doc as { format?: unknown; format_version?: unknown };
  const issue = (path: string, message: string): ContractIssue[] => [{ code: "version", contract: name, path, message }];
  if (typeof d.format === "string" && d.format !== c.format) {
    return issue("format", `expected "${c.format}", got "${d.format}"`);
  }
  if (typeof d.format_version !== "string") return [];
  const found = parseSemVer(d.format_version);
  const supported = parseSemVer(c.version);
  if (!found || !supported) return [];
  if (found.major !== supported.major) {
    return issue("format_version", `unsupported MAJOR ${found.major} (this reader supports ${supported.major}.x); refusing to load`);
  }
  return [];
}
