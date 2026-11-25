import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOKENIZER_NAME, converterDigests, converterLabel, converterVersions, countTokens, encodeTokens, tokenizerLabel } from "../src/index.js";

interface Vectors {
  tiktoken: string;
  encoding: string;
  cases: Array<{ text: string; tokens: number[]; n: number }>;
}
const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/cl100k-vectors.json", import.meta.url)), "utf8")) as Vectors;

describe("cl100k_base (js-tiktoken) against the reference implementation", () => {
  it("the vectors come from OpenAI's tiktoken (python) and name their encoding", () => {
    expect(vectors.encoding).toBe("cl100k_base");
    expect(vectors.tiktoken).toMatch(/^\d+\.\d+\.\d+$/);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(16);
  });

  for (const [i, c] of vectors.cases.entries()) {
    it(`case ${i}: ${JSON.stringify(c.text).slice(0, 48)} -> ${c.n} tokens`, () => {
      expect(encodeTokens(c.text)).toEqual(c.tokens);
      expect(countTokens(c.text)).toBe(c.n);
    });
  }

  it("matches the examples published in the tiktoken README and the OpenAI cookbook", () => {
    expect(encodeTokens("tiktoken is great!")).toEqual([83, 1609, 5963, 374, 2294, 0]);
    expect(encodeTokens("hello world")).toEqual([15339, 1917]);
  });

  it("counts a special-token string as ordinary text instead of throwing", () => {
    expect(countTokens("<|endoftext|>")).toBeGreaterThan(1);
  });

  it("the empty string is 0 tokens", () => expect(countTokens("")).toBe(0));
});

describe("versions", () => {
  it("are read from the installed packages and match the exact pins of package.json", () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { dependencies: Record<string, string> };
    const v = converterVersions();
    expect(v.turndown).toBe(pkg.dependencies["turndown"]);
    expect(v.turndown_plugin_gfm).toBe(pkg.dependencies["turndown-plugin-gfm"]);
    expect(v.js_tiktoken).toBe(pkg.dependencies["js-tiktoken"]);
    expect(v.jsdom).toBe(pkg.dependencies["jsdom"]);
    for (const [name, range] of Object.entries(pkg.dependencies)) expect(range, `${name} must be pinned exactly`).toMatch(/^\d+\.\d+\.\d+$/);
    expect(v.tokenizer).toBe(TOKENIZER_NAME);
    expect(tokenizerLabel()).toBe(`cl100k_base@js-tiktoken@${pkg.dependencies["js-tiktoken"]}`);
    expect(converterLabel()).toContain(`turndown@${pkg.dependencies["turndown"]}+gfm@${pkg.dependencies["turndown-plugin-gfm"]}`);
  });

  it("digests are stable and one per dependency", () => {
    const a = converterDigests();
    expect(Object.keys(a).sort()).toEqual(["gp-markdown", "js-tiktoken", "jsdom", "turndown", "turndown-plugin-gfm"]);
    expect(converterDigests()).toEqual(a);
    for (const d of Object.values(a)) expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
