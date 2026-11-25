import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertValid, type EvalReport } from "@gran-prix/contracts";
import type { ReportExtras } from "../src/index.js";

export const PKG = fileURLToPath(new URL("../", import.meta.url));
export const CONTRACT_FIXTURE = fileURLToPath(new URL("../../contracts/fixtures/valid/eval-report.json", import.meta.url));

export const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

export function loadValid(): EvalReport {
  return assertValid("eval-report", readJson(CONTRACT_FIXTURE));
}
export function loadRich(): EvalReport {
  return assertValid("eval-report", readJson(`${PKG}test/fixtures/rich-eval-report.json`));
}
export function loadExtras(): ReportExtras {
  return readJson(`${PKG}test/fixtures/rich-extras.json`) as ReportExtras;
}

/** Visible text of an HTML document: tags and the stylesheet removed, entities left as is. */
export function textOf(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}
