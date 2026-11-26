// Cheap, language-agnostic-ish text statistics and id/class token handling. Pure: no DOM, no clock, no RNG.

/** Very common function words of a few languages. A stopword ratio, not language detection. */
const STOPWORDS = new Set(
  (
    "the of and to in a is that for it as was with be by on not he this are or his from at which but have an had they " +
    "you were their one all we can her has there been if more when will would who so no what up out about into than them " +
    "de la que el en y los se del las un por con no una su para es al lo como mas pero sus le ya o este si porque " +
    "do da em os uma dos nao mais mas foi ao ele das tem seu sua ou ser quando muito nos ja eu tambem so pelo pela " +
    "le les des du et un une est pas qui dans pour sur au avec ne se ce il elle sont nous vous ils " +
    "der die das und ist von zu den mit sich des auf fur nicht ein eine dem im auch es an als"
  ).split(" "),
);

const PUNCT_RE = /\p{P}/u;
const EDGE_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const ENDS_PUNCT_RE = /[.!?…。！？]["'”’)\]»]*$/;

export interface TextStats {
  /** Words in the sample (own_text may be truncated by the probe). */
  words: number;
  stopwordRatio: number;
  punctRatio: number;
  /** 1 / 0 when the full text was seen; 0.5 when the probe truncated it (the end is unknown). */
  endsWithPunct: number;
}

const MAX_STOPWORD_LEN = Math.max(...[...STOPWORDS].map((w) => w.length));
/** ASCII code -> 1 when `\p{P}` matches it (built with the regex itself, so it cannot disagree with it). */
const ASCII_PUNCT = new Uint8Array(128);
for (let c = 0; c < 128; c++) ASCII_PUNCT[c] = PUNCT_RE.test(String.fromCharCode(c)) ? 1 : 0;

/** ASCII `\s`: tab, LF, VT, FF, CR and space. */
const isWsAscii = (c: number): boolean => c === 32 || (c >= 9 && c <= 13);
const isAlnumAscii = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c >= 65 && c <= 90);
/** ASCII code -> 1 whitespace, 2 letter or digit, 3 `\p{P}`, 0 anything else: one lookup per character in `analyzeText`. */
const ASCII_CLASS = new Uint8Array(128);
for (let c = 0; c < 128; c++) ASCII_CLASS[c] = isWsAscii(c) ? 1 : isAlnumAscii(c) ? 2 : ASCII_PUNCT[c] === 1 ? 3 : 0;

/**
 * `sample` is the node's `own_text` (whitespace already collapsed by the probe, possibly truncated);
 * `fullLen` is `own_text_len` (before truncation).
 *
 * One pass over the code units for ASCII text (words, stopwords, punctuation, the sentence end); the first non-ASCII
 * character sends the whole string to `analyzeTextReference`. The results are the same numbers, computed the same way.
 */
export function analyzeText(sample: string, fullLen: number): TextStats {
  const n = sample.length;
  if (n === 0) return { words: 0, stopwordRatio: 0, punctRatio: 0, endsWithPunct: 0 };
  let words = 0;
  let stop = 0;
  let punct = 0;
  let i = 0;
  while (i < n) {
    let c = sample.charCodeAt(i);
    if (c >= 128) return analyzeTextReference(sample, fullLen);
    if (ASCII_CLASS[c] === 1) { i++; continue; }
    let first = -1; // first and last alphanumeric of the token: the token without its edge punctuation
    let last = -1;
    while (i < n) {
      c = sample.charCodeAt(i);
      if (c >= 128) return analyzeTextReference(sample, fullLen);
      const k = ASCII_CLASS[c] as number;
      if (k === 1) break;
      if (k === 2) { if (first < 0) first = i; last = i; }
      else if (k === 3) punct++;
      i++;
    }
    words++;
    if (first >= 0 && last - first < MAX_STOPWORD_LEN && STOPWORDS.has(sample.slice(first, last + 1).toLowerCase())) stop++;
  }
  let endsWithPunct = 0.5; // the probe truncated the text: the end is unknown
  if (fullLen <= n) {
    let e = n;
    while (e > 0 && isWsAscii(sample.charCodeAt(e - 1))) e--;
    for (let c = e > 0 ? sample.charCodeAt(e - 1) : 0; c === 34 || c === 39 || c === 41 || c === 93; c = e > 0 ? sample.charCodeAt(e - 1) : 0) e--; // closers: " ' ) ]
    const t = e > 0 ? sample.charCodeAt(e - 1) : 0;
    endsWithPunct = t === 46 || t === 33 || t === 63 ? 1 : 0; // . ! ?
  }
  return { words, stopwordRatio: words > 0 ? stop / words : 0, punctRatio: punct / n, endsWithPunct };
}

/**
 * The definition of the text statistics (regex based, any Unicode). `analyzeText` is its single-pass equivalent for the
 * ASCII text that almost every own_text is; test/text-fast.test.ts holds the two together on random strings.
 */
export function analyzeTextReference(sample: string, fullLen: number): TextStats {
  if (sample.length === 0) return { words: 0, stopwordRatio: 0, punctRatio: 0, endsWithPunct: 0 };
  const toks = sample.split(/\s+/);
  let words = 0;
  let stop = 0;
  for (const t of toks) {
    if (t.length === 0) continue;
    words++;
    const w = t.replace(EDGE_RE, "").toLowerCase();
    if (w.length > 0 && STOPWORDS.has(w)) stop++;
  }
  let punct = 0;
  let chars = 0;
  for (const ch of sample) {
    chars++;
    if (PUNCT_RE.test(ch)) punct++;
  }
  const truncated = fullLen > sample.length;
  return {
    words,
    stopwordRatio: words > 0 ? stop / words : 0,
    punctRatio: chars > 0 ? punct / chars : 0,
    endsWithPunct: truncated ? 0.5 : ENDS_PUNCT_RE.test(sample.trimEnd()) ? 1 : 0,
  };
}

/** FNV-1a 32-bit over the UTF-8 bytes of `s`. Matches `hash.fn = "fnv1a32"` in the schema. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    // Combine a surrogate pair into one code point before encoding.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) {
      h = Math.imul(h ^ c, 0x01000193) >>> 0;
    } else if (c < 0x800) {
      h = Math.imul(h ^ (0xc0 | (c >> 6)), 0x01000193) >>> 0;
      h = Math.imul(h ^ (0x80 | (c & 0x3f)), 0x01000193) >>> 0;
    } else if (c < 0x10000) {
      h = Math.imul(h ^ (0xe0 | (c >> 12)), 0x01000193) >>> 0;
      h = Math.imul(h ^ (0x80 | ((c >> 6) & 0x3f)), 0x01000193) >>> 0;
      h = Math.imul(h ^ (0x80 | (c & 0x3f)), 0x01000193) >>> 0;
    } else {
      h = Math.imul(h ^ (0xf0 | (c >> 18)), 0x01000193) >>> 0;
      h = Math.imul(h ^ (0x80 | ((c >> 12) & 0x3f)), 0x01000193) >>> 0;
      h = Math.imul(h ^ (0x80 | ((c >> 6) & 0x3f)), 0x01000193) >>> 0;
      h = Math.imul(h ^ (0x80 | (c & 0x3f)), 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

const isAscii = (v: string): boolean => {
  for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) >= 128) return false;
  return true;
};

/** `idClassTokensReference` of one ASCII value: runs of letters and digits, split before an upper case letter that follows a lower case letter or a digit. */
function pushAsciiTokens(v: string, out: string[]): void {
  const n = v.length;
  let start = -1;
  let allDigits = true;
  let prevLowOrDigit = false;
  for (let i = 0; i <= n; i++) {
    const c = i < n ? v.charCodeAt(i) : 0;
    const digit = c >= 48 && c <= 57;
    const lower = c >= 97 && c <= 122;
    const upper = c >= 65 && c <= 90;
    if (start >= 0 && (!(digit || lower || upper) || (upper && prevLowOrDigit))) {
      const len = i - start;
      if (len >= 2 && len <= 24 && !allDigits) out.push(v.slice(start, i).toLowerCase());
      start = -1;
    }
    if (digit || lower || upper) {
      if (start < 0) { start = i; allDigits = true; }
      if (!digit) allDigits = false;
      prevLowOrDigit = lower || digit;
    }
  }
}

/**
 * Tokens of an id / class string: camelCase and non-alphanumeric boundaries split, lowercased;
 * tokens of fewer than 2 characters, more than 24, or made only of digits are dropped.
 * ASCII values are split by `pushAsciiTokens`; any other value goes through `idClassTokensReference`.
 */
export function idClassTokens(...values: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (!v) continue;
    if (isAscii(v)) pushAsciiTokens(v, out);
    else for (const t of idClassTokensReference(v)) out.push(t);
  }
  return out;
}

/** The definition of the tokenizer (regex based, any Unicode); `idClassTokens` must return the same list. */
export function idClassTokensReference(...values: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (!v) continue;
    const parts = v
      .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u);
    for (const p of parts) {
      if (p.length < 2 || p.length > 24 || /^\p{N}+$/u.test(p)) continue;
      out.push(p);
    }
  }
  return out;
}

export const HINT_NAMES = ["nav", "footer", "ad", "comment", "related", "cookie", "sidebar", "menu", "share"] as const;
export type HintName = (typeof HINT_NAMES)[number];

interface HintRule {
  exact: Set<string>;
  prefix: string[];
}

const HINT_RULES: Record<HintName, HintRule> = {
  nav: { exact: new Set(["nav", "navs", "topnav", "subnav"]), prefix: ["navbar", "navigation", "navlink", "breadcrumb"] },
  footer: { exact: new Set(["foot", "footer", "footers", "colophon", "copyright"]), prefix: ["footer"] },
  ad: {
    exact: new Set(["ad", "ads", "adv", "advert", "adverts", "advertisement", "advertising", "adslot", "adunit", "adsbygoogle", "sponsor", "sponsored", "promo", "promoted"]),
    prefix: ["advert", "adslot", "adsense", "sponsor"],
  },
  comment: { exact: new Set(["reply", "replies", "discussion", "disqus"]), prefix: ["comment"] },
  related: { exact: new Set(["related", "recommended", "suggested", "recirc", "morefrom", "trending"]), prefix: ["related", "recommend", "suggest"] },
  cookie: { exact: new Set(["cookie", "cookies", "consent", "gdpr", "cmp", "ccpa"]), prefix: ["cookie", "consent", "gdpr"] },
  sidebar: { exact: new Set(["sidebar", "sidebars", "aside", "side", "rail", "sidenav"]), prefix: ["sidebar"] },
  menu: { exact: new Set(["menu", "menus", "submenu", "dropdown", "hamburger", "toolbar", "topbar"]), prefix: ["menu", "submenu", "dropdown"] },
  share: { exact: new Set(["share", "sharing", "social", "tweet", "follow"]), prefix: ["share", "sharing", "social"] },
};

/** The definition of `hintBits`: for each hint, does some token match it. */
export function hintBitsReference(tokens: string[]): number {
  let bits = 0;
  for (let h = 0; h < HINT_NAMES.length; h++) {
    const rule = HINT_RULES[HINT_NAMES[h] as HintName];
    for (const t of tokens) {
      let hit = rule.exact.has(t);
      if (!hit) for (const p of rule.prefix) if (t.startsWith(p)) { hit = true; break; }
      if (hit) { bits |= 1 << h; break; }
    }
  }
  return bits;
}

/** exact token -> bits of the hints it matches exactly; prefix -> bit of its hint; first characters that start some prefix. */
const HINT_EXACT = new Map<string, number>();
const HINT_PREFIXES: { prefix: string; bit: number }[] = [];
const HINT_PREFIX_FIRST = new Uint8Array(128);
HINT_NAMES.forEach((name, h) => {
  const rule = HINT_RULES[name];
  for (const t of rule.exact) HINT_EXACT.set(t, (HINT_EXACT.get(t) ?? 0) | (1 << h));
  for (const prefix of rule.prefix) {
    HINT_PREFIXES.push({ prefix, bit: 1 << h });
    HINT_PREFIX_FIRST[prefix.charCodeAt(0)] = 1;
  }
});

/** Bit i set when some token matches the i-th hint of `HINT_NAMES`. Each token is looked up once, for all hints. */
export function hintBits(tokens: string[]): number {
  let bits = 0;
  for (const t of tokens) {
    bits |= HINT_EXACT.get(t) ?? 0;
    const c = t.charCodeAt(0);
    if (c < 128 && HINT_PREFIX_FIRST[c] === 1) for (const p of HINT_PREFIXES) if ((bits & p.bit) === 0 && t.startsWith(p.prefix)) bits |= p.bit;
  }
  return bits;
}

export const ID_CLASS_BUCKETS = 4;

/** Bit b set when some token hashes to bucket b (presence, not count). */
export function bucketBits(tokens: string[]): number {
  let bits = 0;
  for (const t of tokens) bits |= 1 << (fnv1a32(t) % ID_CLASS_BUCKETS);
  return bits;
}
