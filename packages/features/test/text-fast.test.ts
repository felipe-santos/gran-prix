// The fast paths of the vectorizer's text handling (G5 performance work) must return exactly what the regex based
// definitions return. Random strings over an alphabet that stresses every branch: ASCII punctuation, case changes,
// digits, whitespace of every kind, closers, and non-ASCII characters (which must fall back to the definition).
import { describe, expect, it } from "vitest";
import { analyzeText, hintBits, idClassTokens } from "../src/index.js";
import { analyzeTextReference, hintBitsReference, idClassTokensReference } from "../src/vectorize/text.js";

let seed = 20261125;
const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T;

const ASCII_CHARS = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];
const PUNCT = [..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"];
const WS = [" ", " ", " ", "\t", "\n", "\r", "\f", "\v"];
const NON_ASCII = ["é", "Ü", "ß", "日", "本", "。", "！", "…", "”", "’", "»", " ", " ", "﻿", "😀", "\ud83d", "İ", "ı", "K", "ǅ", "١"];
const WORDS = ["the", "of", "and", "The", "AND", "de", "la", "que", "nao", "für", "which", "their", "porque", "it", "I", "a", "x", "ends", "wouldnt"];

function randomText(allowNonAscii: boolean): string {
  const parts: string[] = [];
  const n = Math.floor(rnd() * 14);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.35) parts.push(pick(WORDS));
    else if (r < 0.6) parts.push(Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => pick(ASCII_CHARS)).join(""));
    else if (r < 0.8) parts.push(pick(PUNCT));
    else if (r < 0.9) parts.push(pick(WS));
    else parts.push(allowNonAscii ? pick(NON_ASCII) : pick(PUNCT));
    if (rnd() < 0.5) parts.push(pick(WS));
    if (rnd() < 0.15) parts.push(pick([".", "!", "?", "\"", "'", ")", "]"]));
  }
  return parts.join("");
}

describe("analyzeText fast path = the regex definition", () => {
  for (const nonAscii of [false, true]) {
    it(`random ${nonAscii ? "mixed Unicode" : "ASCII"} texts, whole and truncated`, () => {
      for (let i = 0; i < 6000; i++) {
        const s = randomText(nonAscii);
        for (const fullLen of [s.length, s.length + 1 + Math.floor(rnd() * 500)]) {
          expect(analyzeText(s, fullLen)).toEqual(analyzeTextReference(s, fullLen));
        }
      }
    });
  }
  it("the edge cases", () => {
    for (const s of ["", " ", "   \t\n", "...", "a.", "a. ", "a.\"", "a.')]", "a.'x", "?", "!!!", "the", "The, of; and!", "(the)", "x".repeat(40), "e.g.", "a b.", "end…", "café the.", "😀."]) {
      expect(analyzeText(s, s.length)).toEqual(analyzeTextReference(s, s.length));
      expect(analyzeText(s, s.length + 3)).toEqual(analyzeTextReference(s, s.length + 3));
    }
  });
});

describe("idClassTokens / hintBits fast paths = the definitions", () => {
  const WORD_PARTS = ["nav", "Nav", "NAV", "bar", "Footer", "ad", "Ads", "sponsored", "Sponsor", "comment", "Comments", "relatedPosts", "recommend", "cookieBanner", "consent", "gdpr", "sidebar", "menu", "dropDown", "share", "social", "x", "1", "23", "a1", "B2", "col", "md", "6", "ÜberNav", "日本語", "ﬁnal", "İstanbul", "K", "_", "-", " ", "  ", ".", ":", "\t"];
  function randomValue(): string {
    return Array.from({ length: Math.floor(rnd() * 7) }, () => pick(WORD_PARTS)).join(rnd() < 0.5 ? "" : pick([" ", "-", "_"]));
  }
  it("random id / class strings", () => {
    for (let i = 0; i < 6000; i++) {
      const a = randomValue();
      const b = rnd() < 0.2 ? undefined : randomValue();
      const tokens = idClassTokens(a, b);
      expect(tokens).toEqual(idClassTokensReference(a, b));
      expect(hintBits(tokens)).toBe(hintBitsReference(tokens));
    }
  });
  it("random raw tokens, including the hint words and their prefixes", () => {
    const stems = ["nav", "navbar", "navigation", "navlink", "breadcrumb", "footer", "ad", "ads", "advert", "adslot", "adsense", "sponsor", "sponsored", "comment", "comments", "related", "recommended", "suggest", "cookie", "consent", "gdpr", "cmp", "sidebar", "side", "menu", "submenu", "dropdown", "share", "sharing", "social", "tweet", "follow", "xx", "adx", "navx"];
    for (let i = 0; i < 4000; i++) {
      const toks = Array.from({ length: Math.floor(rnd() * 5) }, () => pick(stems) + (rnd() < 0.3 ? pick(["", "s", "x", "list"]) : ""));
      expect(hintBits(toks)).toBe(hintBitsReference(toks));
    }
  });
  it("the camelCase boundary rule on its own", () => {
    for (const v of ["aB", "aBC", "aBcD", "a1B2C", "AB", "ab", "1A", "A1", "xX9Y", "navBarItem", "NAVbar", "a_B", "a B", "99Bottles", "x".repeat(25), "ab".repeat(12), "ab".repeat(13), "12", "123a", "", "a"]) {
      expect(idClassTokens(v)).toEqual(idClassTokensReference(v));
    }
  });
});
