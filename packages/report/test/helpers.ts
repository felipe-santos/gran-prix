import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertValid, type EvalReport } from "@gran-prix/contracts";
import type { ReportExtras } from "../src/index.js";

export const PKG = fileURLToPath(new URL("../", import.meta.url));
/** The contracts' valid EvalReport fixture (format 1.1.0, structured gates, every v1.1 field). */
export const CONTRACT_FIXTURE = fileURLToPath(new URL("../../contracts/fixtures/valid/eval-report.json", import.meta.url));
/** The frozen v1.0 EvalReport fixture: no structured gates, none of the v1.1 fields. */
export const V10_FIXTURE = fileURLToPath(new URL("../../contracts/fixtures/v1.0/valid/eval-report.json", import.meta.url));

export const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/** The v1.1 contract fixture. */
export function loadValid(): EvalReport {
  return assertValid("eval-report", readJson(CONTRACT_FIXTURE));
}
export function loadV10(): EvalReport {
  return assertValid("eval-report", readJson(V10_FIXTURE));
}
export function loadV10Extras(): ReportExtras {
  return readJson(`${PKG}test/fixtures/v10-extras.json`) as ReportExtras;
}
/** Rich SYNTHETIC v1.0 report: needs the sidecar for CIs, PR curve, D1/D2, gate details and notes. */
export function loadRich(): EvalReport {
  return assertValid("eval-report", readJson(`${PKG}test/fixtures/rich-eval-report.json`));
}
export function loadExtras(): ReportExtras {
  return readJson(`${PKG}test/fixtures/rich-extras.json`) as ReportExtras;
}
/** The same synthetic study as a native v1.1 report: no sidecar needed. */
export function loadRichV11(): EvalReport {
  return assertValid("eval-report", readJson(`${PKG}test/fixtures/rich-eval-report-v11.json`));
}

/** Visible text of an HTML document: tags and the stylesheet removed, entities left as is. */
export function textOf(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

export const sectionIds = (html: string): string[] => [...html.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1] as string);
