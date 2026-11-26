// QA tool, text layer: answer matching and the retention tokens (protocol 9).
import { describe, expect, it } from "vitest";
import { containsPhrase, containsRun, countOccurrences, foldText, isFact, matchAnswer, normalizeAnswer, retentionTokens, tokenFraction, wordCount } from "../src/stages/qa/text.js";

describe("normalizeAnswer", () => {
  it("folds case, diacritics, quotes, dashes, punctuation and thousands separators", () => {
    expect(normalizeAnswer("  Café   Münster! ")).toBe("cafe munster");
    expect(normalizeAnswer("It’s a “nice” day — really")).toBe("it s a nice day really");
    expect(normalizeAnswer("$1,299.00")).toBe("1299 00");
    expect(normalizeAnswer("1,299")).toBe(normalizeAnswer("1299"));
    expect(normalizeAnswer("1,29")).toBe("1 29"); // not a thousands separator
    expect(normalizeAnswer("**bold** [link](http://x)")).toBe("bold link http x");
    expect(foldText("Ａｂｃ")).toBe("abc"); // NFKC
  });
});

describe("containsPhrase and matchAnswer", () => {
  it("contains is by whole words, never by raw substring", () => {
    expect(containsPhrase("the price is 15 dollars", "15")).toBe(true);
    expect(containsPhrase("the price is 15 dollars", "5")).toBe(false);
    expect(containsPhrase("abc", "")).toBe(false);
  });

  it("exact beats contains; variants count; no match is null", () => {
    expect(matchAnswer("Paris", "paris", [])).toBe("exact");
    expect(matchAnswer("The answer is Paris.", "Paris", [])).toBe("contains");
    expect(matchAnswer("It is the French capital", "Paris", ["the French capital"])).toBe("contains");
    expect(matchAnswer("Lyon", "Paris", ["Paris, France"])).toBeNull();
    expect(matchAnswer("", "Paris", [])).toBeNull();
    expect(matchAnswer("1299", "$1,299", [])).toBe("exact");
  });

  it("a number is not found inside a longer number", () => {
    expect(matchAnswer("115", "15", [])).toBeNull();
    expect(matchAnswer("about 15 units", "15", [])).toBe("contains");
  });
});

describe("isFact and wordCount", () => {
  it("a short normalized answer is a fact; a sentence is not", () => {
    expect(isFact("$1,299.00", 5)).toBe(true);
    expect(isFact("Jane Q. Doe", 5)).toBe(true);
    expect(isFact("It sets the maximum number of retries before the call fails", 5)).toBe(false);
    expect(isFact("!!!", 5)).toBe(false);
  });
  it("counts words like the contract", () => {
    expect(wordCount("  a  b\tc\n")).toBe(3);
    expect(wordCount("   ")).toBe(0);
  });
});

describe("retention tokens", () => {
  it("markdown syntax does not change the tokens", () => {
    expect(retentionTokens("**Price:** [$19.99](https://x.test/a)")).toEqual(["price", "19", "99", "https", "x", "test", "a"]);
  });

  it("a contiguous run is found, a broken one is not", () => {
    const hay = retentionTokens("alpha beta gamma delta epsilon");
    expect(containsRun(hay, retentionTokens("beta gamma delta"))).toBe(true);
    expect(containsRun(hay, retentionTokens("beta delta"))).toBe(false);
    expect(containsRun(hay, retentionTokens("epsilon zeta"))).toBe(false);
    expect(containsRun(hay, [])).toBe(false);
  });

  it("the secondary measure counts tokens with multiplicity", () => {
    const hay = retentionTokens("a b b c");
    expect(tokenFraction(hay, retentionTokens("a b c d"))).toBeCloseTo(0.75, 12);
    expect(tokenFraction(hay, retentionTokens("b b b"))).toBeCloseTo(2 / 3, 12);
    expect(tokenFraction([], retentionTokens("a"))).toBe(0);
  });

  it("counts overlapping occurrences", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(3);
    expect(countOccurrences("abc", "d")).toBe(0);
    expect(countOccurrences("abc", "")).toBe(0);
  });
});
