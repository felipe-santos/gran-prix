import { SKIP_TEXT_TAGS, parseFlattened } from "@gran-prix/labels";
import { PageDom, type CollapsedPolicy, type NodeLike } from "@gran-prix/markdown";

/**
 * Where in the D2 markdown does each unit's text sit? The candidate validators need to know which ELEMENTS (units of
 * the labelable universe) an evidence quote touches, to look their gold class up (`noise` evidence is forbidden).
 * `@gran-prix/markdown` converts but keeps no map, and a text search of a unit's own text is wrong for inline markup
 * (a paragraph's own text excludes its links), so the map is made by the converter itself:
 *
 *   1. every non-blank text node directly under a stamped element is wrapped in noncharacter markers (U+FDD0..FDD2) that carry the
 *      element's idx (`U+FDD0 idx U+FDD1 text U+FDD2`), the whitespace at its edges and the prefix turndown's
 *      anchored escapes look at (`1. `, `# `, `- `, ...) left outside/before them, so the converter sees the same text;
 *   2. the converter runs on that document;
 *   3. the markers are stripped from the markdown and recorded as spans `[start, end)` of the CLEAN markdown.
 *
 * The clean markdown must equal the markdown of the unmodified page (the D2 of the study); when it does not, the
 * page is refused (`LocateMismatch`), never guessed at. Pure and deterministic.
 */

const START = "";
const MID = "";
const END = "";

/** Characters of the text at the start that turndown's anchored escapes inspect (`^-`, `^+ `, `^=+`, `^#{1,6} `, `^~~~`, `^>`, `^\d+\. `). */
export function anchoredPrefix(core: string): number {
  let n = 0;
  for (const re of [/^-/, /^\+ /, /^=+/, /^#{1,6} /, /^~~~/, /^>/, /^\d+\. /]) {
    const m = re.exec(core);
    if (m !== null) n = Math.max(n, m[0].length);
  }
  return n;
}

export interface UnitSpan {
  unit: number;
  /** Offsets in the clean markdown, `[start, end)`. */
  start: number;
  end: number;
}

export interface Located {
  markdown: string;
  spans: UnitSpan[];
}

export class LocateMismatch extends Error {
  constructor(message: string) {
    super(`unit map: ${message}`);
    this.name = "LocateMismatch";
  }
}

/** Splits marked markdown into the clean text and the spans. Exported for tests. */
export function stripMarkers(marked: string): Located {
  let clean = "";
  const spans: UnitSpan[] = [];
  let open: { unit: number; start: number } | undefined;
  let i = 0;
  while (i < marked.length) {
    const ch = marked[i] as string;
    if (ch === START) {
      const mid = marked.indexOf(MID, i + 1);
      const idx = mid < 0 ? NaN : Number(marked.slice(i + 1, mid));
      if (mid < 0 || !Number.isInteger(idx)) {
        i++;
        continue;
      }
      open = { unit: idx, start: clean.length };
      i = mid + 1;
    } else if (ch === END) {
      if (open !== undefined) spans.push({ unit: open.unit, start: open.start, end: clean.length });
      open = undefined;
      i++;
    } else if (ch === MID) {
      i++;
    } else {
      clean += ch;
      i++;
    }
  }
  if (open !== undefined) spans.push({ unit: open.unit, start: open.start, end: clean.length });
  return { markdown: clean, spans: spans.filter((s) => s.end > s.start) };
}

const ASCII_WS_LEAD = /^[\t\n\f\r ]*/;
const ASCII_WS_TRAIL = /[\t\n\f\r ]*$/;

/** Marks the text of the stored html, converts, strips, and checks against the plain conversion. */
export function locateUnits(storedHtml: string, nodes: readonly NodeLike[], collapsed?: CollapsedPolicy): Located {
  if (/[\uFDD0-\uFDD2]/.test(storedHtml)) throw new LocateMismatch("the page itself contains the marker characters U+FDD0..FDD2");
  const flat = parseFlattened(storedHtml);
  for (const [idx, el] of flat.elements) {
    if (SKIP_TEXT_TAGS.has(el.tagName)) continue;
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType !== 3) continue;
      const value = child.nodeValue ?? "";
      if (value.trim() === "") continue;
      const lead = ASCII_WS_LEAD.exec(value)?.[0] ?? "";
      const rest = value.slice(lead.length);
      const trail = ASCII_WS_TRAIL.exec(rest)?.[0] ?? "";
      const core = rest.slice(0, rest.length - trail.length);
      const p = anchoredPrefix(core);
      child.nodeValue = `${lead}${core.slice(0, p)}${START}${idx}${MID}${core.slice(p)}${END}${trail}`;
    }
  }
  const root = flat.doc.documentElement;
  const doctype = /^\s*<!doctype/i.test(storedHtml) ? "<!DOCTYPE html>" : "";
  const markedHtml = `${doctype}${root.outerHTML}`;

  const convert = (html: string): string => {
    const page = new PageDom(html, nodes);
    try {
      return page.convert(collapsed === undefined ? {} : { collapsed }).markdown;
    } finally {
      page.dispose();
    }
  };
  const plain = convert(storedHtml);
  const located = stripMarkers(convert(markedHtml));
  if (located.markdown !== plain) {
    let at = 0;
    while (at < plain.length && at < located.markdown.length && plain[at] === located.markdown[at]) at++;
    throw new LocateMismatch(`the marked conversion differs from D2 at offset ${at} (D2 ...${JSON.stringify(plain.slice(Math.max(0, at - 10), at + 30))}, marked ...${JSON.stringify(located.markdown.slice(Math.max(0, at - 10), at + 30))})`);
  }
  return { markdown: plain, spans: located.spans };
}

/** Units whose text overlaps `[start, end)` of the markdown, ascending and distinct. */
export function unitsTouching(spans: readonly UnitSpan[], start: number, end: number): number[] {
  const set = new Set<number>();
  for (const s of spans) if (s.start < end && s.end > start) set.add(s.unit);
  return [...set].sort((a, b) => a - b);
}
