/**
 * numpy.random.default_rng(seed) and Generator.integers(low, high, size) for dtype int64 (the default),
 * bit for bit (numpy/random/_generator.pyx, _bounded_integers.pyx and src/distributions/distributions.c,
 * NumPy 2.5.x, BSD-3-Clause; see NOTICE).
 *
 * The path of `integers` for a range `rng = high - low - 1` (inclusive upper bound):
 *  - rng = 0:                no draw, every value is `low`;
 *  - rng = 2^32 - 1:         one `next_uint32` per value;
 *  - rng < 2^32 - 1:         Lemire's multiply-and-reject on `next_uint32` (two draws per 64-bit output,
 *                            low half first; the buffered half carries over between calls);
 *  - rng > 2^32 - 1:         Lemire on `next_uint64` (here with BigInt: it is not on any hot path).
 * Ranges above 2^53 are refused because the results would not be exact JS numbers.
 */
import { PCG64 } from "./pcg64.js";
import { mul32, MUL_HI } from "./u32.js";

const U32_MAX = 0xffffffff;
const U64_MASK = (1n << 64n) - 1n;

export class Generator {
  constructor(readonly bitGenerator: PCG64) {}

  /** `numpy.random.default_rng(seed)` for an integer seed. */
  static defaultRng(seed: number | bigint): Generator {
    return new Generator(new PCG64(seed));
  }

  /** `integers(low, high)`: one value in [low, high). */
  integers(low: number, high: number): number;
  /** `integers(low, high, size)`: `size` values in [low, high), drawn in order. */
  integers(low: number, high: number, size: number): Float64Array;
  integers(low: number, high: number, size?: number): number | Float64Array {
    const rng = checkRange(low, high);
    if (size === undefined) return low + this.bounded(rng);
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("size must be a non-negative integer");
    const out = new Float64Array(size);
    this.fill(out, low, high);
    return out;
  }

  /** Same draws as `integers(low, high, out.length)`, written into `out` (no allocation). */
  fill(out: Float64Array | Int32Array | Uint32Array, low: number, high: number): void {
    const rng = checkRange(low, high);
    const n = out.length;
    if (rng === 0) {
      out.fill(low);
    } else if (rng < U32_MAX) {
      const bg = this.bitGenerator;
      const rngExcl = rng + 1;
      const threshold = (U32_MAX - rng) % rngExcl;
      for (let i = 0; i < n; i++) {
        let lo = mul32(bg.nextUint32(), rngExcl);
        let hi = MUL_HI;
        if (lo < rngExcl) {
          while (lo < threshold) {
            lo = mul32(bg.nextUint32(), rngExcl);
            hi = MUL_HI;
          }
        }
        out[i] = low + hi;
      }
    } else {
      for (let i = 0; i < n; i++) out[i] = low + this.bounded(rng);
    }
  }

  /** One value in [0, rng] (rng = high - low - 1), the offset `low` not yet added. */
  private bounded(rng: number): number {
    const bg = this.bitGenerator;
    if (rng === 0) return 0;
    if (rng === U32_MAX) return bg.nextUint32();
    if (rng < U32_MAX) {
      const rngExcl = rng + 1;
      let lo = mul32(bg.nextUint32(), rngExcl);
      let hi = MUL_HI;
      if (lo < rngExcl) {
        const threshold = (U32_MAX - rng) % rngExcl;
        while (lo < threshold) {
          lo = mul32(bg.nextUint32(), rngExcl);
          hi = MUL_HI;
        }
      }
      return hi;
    }
    // bounded_lemire_uint64
    const rngExcl = BigInt(rng) + 1n;
    let m = bg.nextUint64() * rngExcl;
    let leftover = m & U64_MASK;
    if (leftover < rngExcl) {
      const threshold = (U64_MASK - BigInt(rng)) % rngExcl;
      while (leftover < threshold) {
        m = bg.nextUint64() * rngExcl;
        leftover = m & U64_MASK;
      }
    }
    return Number(m >> 64n);
  }
}

function checkRange(low: number, high: number): number {
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)) throw new RangeError("low and high must be safe integers");
  if (low >= high) throw new RangeError(`low >= high (${low} >= ${high})`);
  const rng = high - 1 - low;
  if (!Number.isSafeInteger(rng)) throw new RangeError("the range of integers() exceeds 2^53");
  return rng;
}
