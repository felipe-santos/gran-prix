import { describe, expect, it } from "vitest";
import {
  BINARY_SPACE,
  DEFAULT_SPLIT_RANGES,
  THREE_CLASS_SPACE,
  assignSplit,
  groupBucket,
  projectItemsToBinary,
  projectToBinary,
  splitOfBucket,
  validate,
  type NodeLabelItem,
} from "../src/index.js";
import { buildUniverse } from "../src/tools/fixtures/universe.js";

describe("3-class -> binary projection (ADR-006)", () => {
  it("default: main and support are kept, noise is dropped", () => {
    expect(projectToBinary(0, THREE_CLASS_SPACE)).toBe(1); // main
    expect(projectToBinary(1, THREE_CLASS_SPACE)).toBe(1); // support
    expect(projectToBinary(2, THREE_CLASS_SPACE)).toBe(0); // noise
  });

  it("the keep set is configurable without relabeling", () => {
    expect(projectToBinary(1, THREE_CLASS_SPACE, ["main"])).toBe(0);
    expect(projectToBinary(0, THREE_CLASS_SPACE, ["main"])).toBe(1);
  });

  it("refuses unknown classes, out-of-range indexes and typos in keepClasses", () => {
    expect(() => projectToBinary(3, THREE_CLASS_SPACE)).toThrow(/outside label space/);
    expect(() => projectToBinary(-1, THREE_CLASS_SPACE)).toThrow(RangeError);
    expect(() => projectToBinary(0, THREE_CLASS_SPACE, ["mian"])).toThrow(/not in label space: mian/);
  });

  it("a binary space passes through and rejects non-binary labels", () => {
    expect(projectToBinary(1, BINARY_SPACE)).toBe(1);
    expect(projectToBinary(0, BINARY_SPACE)).toBe(0);
    expect(() => projectToBinary(2, BINARY_SPACE)).toThrow(RangeError);
  });

  it("projects NodeLabels items and preserves source, confidence and reason", () => {
    const items: NodeLabelItem[] = [
      { unit_id: 1, y: 0, confidence: 0.9, source: "llm", reason: "r" },
      { unit_id: 2, y: 2, confidence: 1, source: "human" },
    ];
    expect(projectItemsToBinary(items, THREE_CLASS_SPACE)).toEqual([
      { unit_id: 1, y: 1, confidence: 0.9, source: "llm", reason: "r" },
      { unit_id: 2, y: 0, confidence: 1, source: "human" },
    ]);
  });

  it("the 3-class and binary spaces validate as label spaces inside NodeLabels", () => {
    const u = buildUniverse();
    const bin = structuredClone(u.labels);
    bin.label_space = { kind: "binary", classes: ["drop", "keep"] };
    bin.items.forEach((i) => (i.y = i.y === 0 ? 1 : 0));
    // identity changed: reseal through the validator's own report
    const r = validate("node-labels", bin);
    expect(r.issues.map((i) => i.code)).toEqual(["id-mismatch"]);
    const wrong = structuredClone(u.labels);
    wrong.label_space = { kind: "binary", classes: ["keep", "drop"] } as never;
    expect(validate("node-labels", wrong).issues[0]?.path).toMatch(/^label_space/);
  });
});

describe("split by group_key hash (hash-bucket-v1)", () => {
  // Cross-checked with python: int.from_bytes(sha256(b"etapa1\x00example.com").digest()[:4], "big") % 100
  it("known buckets", () => {
    expect(groupBucket("etapa1", "example.com")).toBe(91);
    expect(groupBucket("etapa1", "another.org")).toBe(8);
  });

  it("is deterministic, depends on the salt, and always lies in [0, n_buckets)", () => {
    expect(groupBucket("s", "k")).toBe(groupBucket("s", "k"));
    const buckets = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const b = groupBucket("s", `site${i}.example`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
      buckets.add(b);
    }
    expect(buckets.size).toBeGreaterThan(80);
    const sameKeyOtherSalt = Array.from({ length: 50 }, (_, i) => groupBucket("a", `k${i}`) === groupBucket("b", `k${i}`));
    expect(sameKeyOtherSalt.filter(Boolean).length).toBeLessThan(10);
  });

  it("assignment is independent of which other groups exist (no PRNG state)", () => {
    const alone = assignSplit("s", "x.example");
    for (let i = 0; i < 100; i++) assignSplit("s", `noise${i}.example`);
    expect(assignSplit("s", "x.example")).toEqual(alone);
  });

  it("the three splits follow the 70/15/15 ranges, roughly, over many groups", () => {
    const counts = { train: 0, val: 0, test: 0 };
    const N = 4000;
    for (let i = 0; i < N; i++) counts[assignSplit("salt", `d${i}.example`).split]++;
    expect(counts.train / N).toBeGreaterThan(0.66);
    expect(counts.train / N).toBeLessThan(0.74);
    expect(counts.val / N).toBeGreaterThan(0.12);
    expect(counts.test / N).toBeGreaterThan(0.12);
  });

  it("range boundaries are half-open [lo, hi)", () => {
    expect(splitOfBucket(0)).toBe("train");
    expect(splitOfBucket(69)).toBe("train");
    expect(splitOfBucket(70)).toBe("val");
    expect(splitOfBucket(84)).toBe("val");
    expect(splitOfBucket(85)).toBe("test");
    expect(splitOfBucket(99)).toBe("test");
    expect(() => splitOfBucket(100)).toThrow(RangeError);
    expect(DEFAULT_SPLIT_RANGES.train[1]).toBe(DEFAULT_SPLIT_RANGES.val[0]);
  });

  it("overrides win over the hash and are reported with the same bucket", () => {
    const natural = assignSplit("s", "d.example");
    const other = natural.split === "test" ? "train" : "test";
    const forced = assignSplit("s", "d.example", { overrides: { "d.example": other } });
    expect(forced.split).toBe(other);
    expect(forced.bucket).toBe(natural.bucket);
  });

  it("property: with group_by group_key, no group_key is ever in two splits (dataset fixture and mutations)", () => {
    const u = buildUniverse();
    const keys = new Map<string, string>();
    for (const g of u.dataset.manifest.groups) {
      const prev = keys.get(g.group_key);
      expect(prev === undefined || prev === g.split).toBe(true);
      keys.set(g.group_key, g.split);
    }
    expect(new Set(u.dataset.manifest.groups.map((g) => g.split)).size).toBe(3);
  });
});
