import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Reads a jsonl file (missing file = empty). A truncated last line (killed run) is dropped. */
export function readJsonlSync(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* partial line from an interrupted append */
    }
  }
  return out;
}
export const readJsonl = async (path) => readJsonlSync(path);

/** Atomic rewrite (tmp + rename). */
export async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : ""));
  await rename(tmp, path);
}

/** Synchronous append: one line per call, so an interrupted run loses at most the line being written. */
export const appendJsonl = (path, row) => appendFileSync(path, `${JSON.stringify(row)}\n`);
