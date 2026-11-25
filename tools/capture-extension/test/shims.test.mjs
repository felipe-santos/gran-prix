import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHash as shimHash } from "../src/shims/crypto.js";
import { sha256HexOfBytes } from "../src/shims/sha256.js";
import { Buffer as BufferShim } from "../src/shims/buffer.js";
import { baseNameOf, chromeVersionOf, stripUrl } from "../src/build-capture.js";

const ref = (data) => createHash("sha256").update(data).digest("hex");

describe("sha256 shim (replaces node:crypto in the bundle)", () => {
  it("matches node:crypto on the standard vectors and around the 55/56/64-byte padding boundaries", () => {
    for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(63), "a".repeat(64), "a".repeat(65), "a".repeat(119), "a".repeat(120), "a".repeat(128)]) {
      expect(sha256HexOfBytes(new TextEncoder().encode(s)), JSON.stringify(s.slice(0, 8)) + s.length).toBe(ref(s));
    }
  });
  it("matches on UTF-8 text (accents, CJK, emoji) and on random bytes", () => {
    const text = "Ação é nó: 日本語のテキスト 🚀 \u0000 end";
    expect(shimHash("sha256").update(text).digest("hex")).toBe(ref(text));
    for (const n of [1, 17, 1000, 65_537]) {
      const b = randomBytes(n);
      expect(sha256HexOfBytes(b)).toBe(ref(b));
    }
  });
  it("matches on a multi-megabyte input and on chunked updates", () => {
    const big = randomBytes(6 * 1024 * 1024);
    expect(sha256HexOfBytes(big)).toBe(ref(big));
    expect(shimHash("sha256").update("ab").update("c").digest("hex")).toBe(ref("abc"));
  });
  it("refuses what it does not implement", () => {
    expect(() => shimHash("md5")).toThrow(/only sha256/);
    expect(() => shimHash("sha256").update("x").digest("base64")).toThrow(/only digest/);
  });
  it("Buffer.byteLength counts UTF-8 bytes like Node", () => {
    for (const s of ["", "abc", "ação", "日本語", "🚀"]) expect(BufferShim.byteLength(s, "utf8")).toBe(Buffer.byteLength(s, "utf8"));
  });
});

describe("url and version helpers", () => {
  it("drops query and fragment (tokens, share keys), keeps origin and path", () => {
    expect(stripUrl("https://app.example.com/w/123/page?token=abc&x=1#frag")).toBe("https://app.example.com/w/123/page");
    expect(stripUrl("http://127.0.0.1:8080/docs-3.html?a=b")).toBe("http://127.0.0.1:8080/docs-3.html");
    expect(stripUrl("not a url")).toBe("not a url");
  });
  it("reads the Chrome version out of the user agent", () => {
    expect(chromeVersionOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36")).toBe("131.0.6778.86");
    expect(chromeVersionOf("curl/8")).toBe("unknown");
  });
  it("names both files of a capture after the snapshot hash", () => {
    expect(baseNameOf(`sha256:${"ab".repeat(32)}`)).toBe("ab".repeat(32));
  });
});
