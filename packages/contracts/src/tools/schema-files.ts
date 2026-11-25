import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { schemaFileName, schemaFileText } from "../jsonschema.js";
import { CONTRACT_NAMES } from "../registry.js";

function expectedFiles(): Map<string, string> {
  return new Map(CONTRACT_NAMES.map((n) => [schemaFileName(n), schemaFileText(n)]));
}

/** Differences between `dir` and what the TypeBox definitions generate. Empty = in sync. */
export function schemaProblems(dir: string): string[] {
  const problems: string[] = [];
  const expected = expectedFiles();
  for (const [file, text] of expected) {
    const p = join(dir, file);
    if (!existsSync(p)) problems.push(`missing: schemas/${file}`);
    else if (readFileSync(p, "utf8") !== text) problems.push(`stale or hand-edited: schemas/${file}`);
  }
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".json") && !expected.has(f)) problems.push(`unexpected file: schemas/${f}`);
    }
  }
  return problems;
}

/** Writes the generated schema files; returns how many files changed. */
export function writeSchemas(dir: string): { total: number; changed: number } {
  const expected = expectedFiles();
  mkdirSync(dir, { recursive: true });
  let changed = 0;
  for (const [file, text] of expected) {
    const p = join(dir, file);
    if (!existsSync(p) || readFileSync(p, "utf8") !== text) {
      writeFileSync(p, text);
      changed++;
    }
  }
  return { total: expected.size, changed };
}
