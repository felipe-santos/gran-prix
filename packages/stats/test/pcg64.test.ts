// The limb arithmetic of PCG64 against a plain BigInt implementation of the same recurrence, on states that
// numpy does not publish (random seeds), plus the range checks of Generator.integers.
import { describe, expect, it } from "vitest";
import { Generator, PCG64, SeedSequence } from "../src/index.js";

const M128 = (1n << 128n) - 1n;
const MULT = 47026247687942121848144207491837523525n;

/** pcg_setseq_128_xsl_rr_64 with NumPy's seeding, in BigInt. */
function reference(seed: bigint): () => bigint {
  const w = new SeedSequence(seed).generateState(8);
  const u64 = (k: number): bigint => (BigInt(w[2 * k + 1] as number) << 32n) | BigInt(w[2 * k] as number);
  const initstate = (u64(0) << 64n) | u64(1);
  const initseq = (u64(2) << 64n) | u64(3);
  const inc = ((initseq << 1n) | 1n) & M128;
  let state = 0n;
  const step = (): void => {
    state = (state * MULT + inc) & M128;
  };
  step();
  state = (state + initstate) & M128;
  step();
  return () => {
    step();
    const x = (state >> 64n) ^ (state & ((1n << 64n) - 1n));
    const rot = BigInt(state >> 122n);
    return ((x >> rot) | (x << ((64n - rot) & 63n))) & ((1n << 64n) - 1n);
  };
}

describe("PCG64 limb arithmetic", () => {
  it("equals the BigInt recurrence for 40 seeds x 500 outputs", () => {
    for (let s = 0; s < 40; s++) {
      const seed = BigInt(s) * 0x9e3779b97f4a7c15n + BigInt(s * s);
      const ref = reference(seed);
      const g = new PCG64(seed);
      for (let i = 0; i < 500; i++) expect(g.nextUint64()).toBe(ref());
    }
  });

  it("next_uint32 serves the low half first, then the high half, then draws again", () => {
    const a = new PCG64(5);
    const b = new PCG64(5);
    const w1 = b.nextUint64();
    const w2 = b.nextUint64();
    expect([a.nextUint32(), a.nextUint32(), a.nextUint32()]).toEqual([Number(w1 & 0xffffffffn), Number(w1 >> 32n), Number(w2 & 0xffffffffn)]);
  });
});

describe("Generator.integers", () => {
  it("is deterministic per seed and stays inside [low, high)", () => {
    const a = Generator.defaultRng(9).integers(-5, 5, 1000);
    const b = Generator.defaultRng(9).integers(-5, 5, 1000);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Math.min(...a)).toBeGreaterThanOrEqual(-5);
    expect(Math.max(...a)).toBeLessThan(5);
    expect(new Set(a).size).toBe(10);
  });

  it("a range of one value draws nothing", () => {
    const g = Generator.defaultRng(3);
    const before = Generator.defaultRng(3).integers(0, 100);
    expect(Array.from(g.integers(7, 8, 5))).toEqual([7, 7, 7, 7, 7]);
    expect(g.integers(0, 100)).toBe(before);
  });

  it("refuses empty or inverted ranges, non-integers and ranges above 2^53", () => {
    const g = Generator.defaultRng(1);
    expect(() => g.integers(3, 3)).toThrow(RangeError);
    expect(() => g.integers(5, 2)).toThrow(RangeError);
    expect(() => g.integers(0, 1.5)).toThrow(RangeError);
    expect(() => g.integers(0, 4, -1)).toThrow(RangeError);
    expect(() => g.integers(-(2 ** 53) + 1, 2 ** 53 - 1)).toThrow(RangeError);
    expect(() => new PCG64(-1)).toThrow(RangeError);
    expect(() => new PCG64(1.5)).toThrow(RangeError);
  });
});
