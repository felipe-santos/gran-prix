import type { EvalReport } from "@gran-prix/contracts";
import type { ReportExtras } from "./extras.js";
import { esc } from "./format.js";

/** What every section renderer reads. */
export interface Ctx {
  r: EvalReport;
  x: ReportExtras;
}

export interface Section {
  id: string;
  title: string;
  html: string;
}

export type Intrinsic = NonNullable<EvalReport["intrinsic"]>;
export type Downstream = NonNullable<EvalReport["downstream"]>;

export function section(id: string, title: string, body: string): Section {
  return { id, title, html: `<section id="${esc(id)}" aria-labelledby="${esc(id)}-h"><h2 id="${esc(id)}-h">${esc(title)}</h2>${body}</section>` };
}

/** One-line placeholder for a section whose data is not in the report. */
export function absent(text: string): string {
  return `<p class="absent">${esc(text)}</p>`;
}

export function noteLine(text: string): string {
  return `<p class="note-line">${esc(text)}</p>`;
}

const ICON_PASS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_FAIL = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;

/** PASS / FAIL as text plus an icon: readable without color. */
export function statusBadge(passed: boolean): string {
  return passed
    ? `<span class="badge pass">${ICON_PASS}PASS</span>`
    : `<span class="badge fail">${ICON_FAIL}FAIL</span>`;
}

/** A scrollable table wrapper; the page itself never scrolls horizontally. */
export function tableWrap(table: string): string {
  return `<div class="scroll" tabindex="0" role="region" aria-label="Table, scrolls horizontally on narrow screens">${table}</div>`;
}

export function th(label: string, numeric = false, scope = "col"): string {
  return `<th scope="${scope}"${numeric ? ' class="n"' : ""}>${esc(label)}</th>`;
}

/** Numeric cell with an optional CI line underneath. */
export function numCell(value: string, ciText?: string): string {
  return `<td class="n">${esc(value)}${ciText ? `<span class="ci">${esc(ciText)}</span>` : ""}</td>`;
}

export function kv(rows: [string, string][]): string {
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

export function tile(label: string, value: string): string {
  return `<div class="tile"><span class="l">${esc(label)}</span><span class="v">${esc(value)}</span></div>`;
}

/** An id as a monospace chip with the full value always present in the text. */
export function codeId(id: string): string {
  return `<code>${esc(id)}</code>`;
}
