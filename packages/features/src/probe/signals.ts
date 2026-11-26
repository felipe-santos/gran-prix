// Page-level signals that live outside any one element: og:type and JSON-LD @type.

import { getAttr, queryDoc, queryDocAll, textContentOf } from "./dom.js";

const MAX_JSONLD_BYTES = 1_000_000;
const MAX_TYPES = 16;

/** Lone surrogates make a string invalid for canonical JSON (the content-id hash throws). Each one becomes U+FFFD. */
export function wellFormedReference(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

type WellFormedString = { isWellFormed?: () => boolean; toWellFormed?: () => string };
const NATIVE = typeof (String.prototype as WellFormedString).isWellFormed === "function" && typeof (String.prototype as WellFormedString).toWellFormed === "function";

/** `wellFormedReference`, through the engine's own `isWellFormed` / `toWellFormed` (Chromium 111+) when they exist: the same result, one native call for the usual string without a lone surrogate. */
export function wellFormed(s: string): string {
  if (NATIVE) return (s as WellFormedString).isWellFormed!() ? s : (s as WellFormedString).toWellFormed!();
  return wellFormedReference(s);
}

export function ogType(): string | undefined {
  const meta = queryDoc('meta[property="og:type" i], meta[name="og:type" i]');
  const v = meta ? getAttr(meta, "content")?.trim().toLowerCase() : undefined;
  return v ? wellFormed(v.slice(0, 64)) : undefined;
}

/** Distinct JSON-LD `@type` values in document order (schema.org URL prefixes stripped), capped. */
export function jsonLdTypes(): string[] {
  const out: string[] = [];
  const add = (t: unknown): void => {
    const s = typeof t === "string" ? t.trim().replace(/^https?:\/\/schema\.org\//i, "") : "";
    if (s && s.length <= 64 && !out.includes(s) && out.length < MAX_TYPES) out.push(wellFormed(s));
  };
  const visit = (v: unknown, depth: number): void => {
    if (depth > 8 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const e of v) visit(e, depth + 1); return; }
    const o = v as Record<string, unknown>;
    const t = o["@type"];
    if (Array.isArray(t)) t.forEach(add); else add(t);
    for (const k of Object.keys(o)) if (k !== "@type" && k !== "@context") visit(o[k], depth + 1);
  };
  for (const s of queryDocAll('script[type="application/ld+json" i]')) {
    const text = textContentOf(s) ?? "";
    if (text.length === 0 || text.length > MAX_JSONLD_BYTES) continue;
    try { visit(JSON.parse(text), 0); } catch { /* malformed JSON-LD is common; ignore */ }
  }
  return out;
}
