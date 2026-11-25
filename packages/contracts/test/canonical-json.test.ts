import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalJson } from "../src/index.js";

describe("canonicalJson: structure", () => {
  it("sorts keys regardless of insertion order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it("sorts nested objects recursively and keeps array order", () => {
    const v = { z: [3, 1, 2], y: { b: { d: 1, c: 2 }, a: null } };
    expect(canonicalJson(v)).toBe('{"y":{"a":null,"b":{"c":2,"d":1}},"z":[3,1,2]}');
  });

  it("emits no whitespace and handles empty containers", () => {
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson({ a: [], b: {} })).toBe('{"a":[],"b":{}}');
  });

  it("sorts keys by UTF-16 code units (RFC 8785 section 3.2.3 vector)", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    // Expected order from the RFC: \r, 1, U+0080, U+00F6, U+20AC, U+1F600 (surrogate pair), U+FB33.
    const order = ["\r", "1", "\u0080", "ö", "€", "😀", "דּ"] as const;
    const rec = input as Record<string, string>;
    const expected = `{${order.map((k) => `${JSON.stringify(k)}:${JSON.stringify(rec[k])}`).join(",")}}`;
    expect(canonicalJson(input)).toBe(expected);
  });

  it("omits object members whose value is undefined (like JSON.stringify)", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("matches the full RFC 8785 section 3.2.2 sample", () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    ) as unknown;
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });
});

describe("canonicalJson: number formatting (ECMAScript Number::toString)", () => {
  const cases: Array<[number, string]> = [
    [0, "0"],
    [-0, "0"],
    [1, "1"],
    [-1, "-1"],
    [4.5, "4.5"],
    [0.002, "0.002"],
    [1e21, "1e+21"],
    [1e-7, "1e-7"],
    [1.5e-7, "1.5e-7"],
    [123456789012345680000, "123456789012345680000"],
    [1e30, "1e+30"],
    [0.000001, "0.000001"],
    [0.0000001, "1e-7"],
    [333333333.33333329, "333333333.3333333"],
    // RFC 8785 appendix B
    [9007199254740991, "9007199254740991"],
    [-9007199254740991, "-9007199254740991"],
    [9223372036854775807, "9223372036854776000"],
    [5e-324, "5e-324"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
    [4294967295, "4294967295"],
    [0.1 + 0.2, "0.30000000000000004"],
    [Math.fround(0.3), "0.30000001192092896"],
  ];
  it.each(cases)("%s -> %s", (n, text) => {
    expect(canonicalJson(n)).toBe(text);
    expect(canonicalJson([n])).toBe(`[${text}]`);
  });

  it("prints a float32 value with its exact double expansion (so Math.fround survives a round-trip)", () => {
    const f = Math.fround(0.1);
    expect(JSON.parse(canonicalJson(f))).toBe(f);
    expect(Math.fround(JSON.parse(canonicalJson(f)) as number)).toBe(f);
  });
});

describe("canonicalJson: strings", () => {
  it("escapes control characters, quote and backslash; keeps other characters raw", () => {
    expect(canonicalJson("a\"b\\c\n\t\b\f\r")).toBe('"a\\"b\\\\c\\n\\t\\b\\f\\r"');
    expect(canonicalJson("\u0000\u001f")).toBe('"\\u0000\\u001f"');
    expect(canonicalJson("/")).toBe('"/"');
  });

  it("keeps unicode raw (no \\u escapes for printable code points) and U+2028/2029 raw", () => {
    expect(canonicalJson("café € 😀")).toBe('"café € 😀"');
    expect(canonicalJson("  ")).toBe('"  "');
  });

  it("does not normalize unicode: precomposed and decomposed strings hash differently", () => {
    expect(canonicalJson("é")).not.toBe(canonicalJson("é"));
  });

  it("rejects lone surrogates in values and in keys", () => {
    expect(() => canonicalJson("\ud800")).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ "\udc00": 1 })).toThrow(/lone surrogate/);
  });
});

describe("canonicalJson: rejected input", () => {
  it.each([NaN, Infinity, -Infinity])("rejects %s", (n) => {
    expect(() => canonicalJson(n)).toThrow(/non-finite/);
    expect(() => canonicalJson({ deep: { v: [n] } })).toThrow(/\.deep\.v\[0\]/);
  });

  it("rejects undefined at top level and in arrays, and other non-JSON types", () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson([undefined])).toThrow(/unsupported type undefined/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/unsupported type function/);
    expect(() => canonicalJson(10n)).toThrow(/bigint/);
    expect(() => canonicalJson(Symbol("x"))).toThrow(/symbol/);
  });

  it("rejects non-plain objects (Date, Map, Set, typed arrays, class instances)", () => {
    expect(() => canonicalJson(new Date(0))).toThrow(/Date/);
    expect(() => canonicalJson(new Map())).toThrow(/Map/);
    expect(() => canonicalJson(new Set())).toThrow(/Set/);
    expect(() => canonicalJson(new Float32Array(2))).toThrow(/Float32Array/);
    class P {
      x = 1;
    }
    expect(() => canonicalJson(new P())).toThrow(/\(P\)/);
  });

  it("rejects cycles and sparse arrays", () => {
    const a: Record<string, unknown> = {};
    a["self"] = a;
    expect(() => canonicalJson(a)).toThrow(/circular/);
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalJson([1, , 3])).toThrow(/sparse/);
  });

  it("accepts null-prototype objects and reports the failing path", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o["b"] = 1;
    o["a"] = 2;
    expect(canonicalJson(o)).toBe('{"a":2,"b":1}');
    try {
      canonicalJson({ a: [{ b: NaN }] });
      expect.unreachable();
    } catch (e) {
      expect((e as CanonicalJsonError).path).toBe(".a[0].b");
    }
  });
});
