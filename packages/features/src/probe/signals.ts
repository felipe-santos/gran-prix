// Page-level signals that live outside any one element: og:type and JSON-LD @type.

const MAX_JSONLD_BYTES = 1_000_000;
const MAX_TYPES = 16;

/** Lone surrogates make a string invalid for canonical JSON (the content-id hash throws). */
export function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

export function ogType(): string | undefined {
  const meta = document.querySelector('meta[property="og:type" i], meta[name="og:type" i]');
  const v = meta?.getAttribute("content")?.trim().toLowerCase();
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
  for (const s of document.querySelectorAll('script[type="application/ld+json" i]')) {
    const text = s.textContent ?? "";
    if (text.length === 0 || text.length > MAX_JSONLD_BYTES) continue;
    try { visit(JSON.parse(text), 0); } catch { /* malformed JSON-LD is common; ignore */ }
  }
  return out;
}
