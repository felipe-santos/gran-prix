/**
 * numpy.random.PCG64 (numpy/random/_pcg64.pyx and src/pcg64/pcg64.h, NumPy 2.5.x, BSD-3-Clause; the
 * algorithm is PCG XSL-RR 128/64 by M. O'Neill, MIT; see NOTICE). The 128-bit state and increment are
 * kept as four 32-bit limbs (least significant first) so that the hot path allocates nothing and uses
 * no BigInt. Seeding is `SeedSequence(seed).generate_state(4, uint64)`: words 0,1 are the high and low
 * half of the initial state, words 2,3 those of the stream increment.
 *
 * Differences from the reference PCG that matter: NumPy steps the state FIRST and outputs the NEW
 * state; `next_uint32` returns the low half of a 64-bit output and keeps the high half for the next call.
 */
import { SeedSequence } from "./seed-sequence.js";
import { mul32, MUL_HI } from "./u32.js";

/** The default 128-bit LCG multiplier 47026247687942121848144207491837523525, least significant limb first. */
const MULT = Uint32Array.of(0x9fccf645, 0x4385df64, 0x1fc65da4, 0x2360ed05);

export class PCG64 {
  private readonly s = new Uint32Array(4);
  private readonly inc = new Uint32Array(4);
  private hasUint32 = false;
  private uinteger = 0;
  /** High and low 32 bits of the last `step`+output; read right after `nextUint64Parts()`. */
  hi = 0;
  lo = 0;

  constructor(seed: number | bigint) {
    const w = new SeedSequence(seed).generateState(8);
    // val[k] = w[2k] | w[2k+1] << 32; initstate = val[0]<<64 | val[1]; initseq = val[2]<<64 | val[3]
    const initstate = [w[2], w[3], w[0], w[1]] as number[];
    const initseq = [w[6], w[7], w[4], w[5]] as number[];
    // inc = (initseq << 1) | 1
    const inc = this.inc;
    let carry = 1;
    for (let i = 0; i < 4; i++) {
      const x = initseq[i] as number;
      inc[i] = ((x << 1) | carry) >>> 0;
      carry = x >>> 31;
    }
    // pcg_setseq_128_srandom_r: state = 0; step; state += initstate; step
    this.step();
    let c = 0;
    for (let i = 0; i < 4; i++) {
      const t = (this.s[i] as number) + (initstate[i] as number) + c;
      this.s[i] = t >>> 0;
      c = t > 0xffffffff ? 1 : 0;
    }
    this.step();
  }

  /** state = state * MULT + inc (mod 2^128). */
  private step(): void {
    const s = this.s;
    const s0 = s[0] as number;
    const s1 = s[1] as number;
    const s2 = s[2] as number;
    const s3 = s[3] as number;
    const m0 = MULT[0] as number;
    const m1 = MULT[1] as number;
    const m2 = MULT[2] as number;
    const m3 = MULT[3] as number;
    // Schoolbook product mod 2^128. Column k adds the low words of a_i*b_j (i+j=k), the high words of
    // those with i+j=k-1 and the carry of the column below (sums stay under 2^36, exact in a double).
    const r0 = mul32(s0, m0);
    const h00 = MUL_HI;
    const l01 = mul32(s0, m1);
    const h01 = MUL_HI;
    const l10 = mul32(s1, m0);
    const h10 = MUL_HI;
    let col = h00 + l01 + l10;
    const r1 = col >>> 0;
    let carry = Math.floor(col / 4294967296);
    const l02 = mul32(s0, m2);
    const h02 = MUL_HI;
    const l11 = mul32(s1, m1);
    const h11 = MUL_HI;
    const l20 = mul32(s2, m0);
    const h20 = MUL_HI;
    col = carry + h01 + h10 + l02 + l11 + l20;
    const r2 = col >>> 0;
    carry = Math.floor(col / 4294967296);
    col = carry + h02 + h11 + h20 + (Math.imul(s0, m3) >>> 0) + (Math.imul(s1, m2) >>> 0) + (Math.imul(s2, m1) >>> 0) + (Math.imul(s3, m0) >>> 0);
    const r3 = col >>> 0;
    // + inc
    const inc = this.inc;
    let t = r0 + (inc[0] as number);
    s[0] = t >>> 0;
    t = r1 + (inc[1] as number) + (t > 0xffffffff ? 1 : 0);
    const c1 = t > 0xffffffff ? 1 : 0;
    s[1] = t >>> 0;
    t = r2 + (inc[2] as number) + c1;
    const c2 = t > 0xffffffff ? 1 : 0;
    s[2] = t >>> 0;
    s[3] = (r3 + (inc[3] as number) + c2) >>> 0;
  }

  /** `random_raw()`: advances and leaves the 64-bit output in `hi`/`lo`. */
  nextUint64Parts(): void {
    this.step();
    const s = this.s;
    const s3 = s[3] as number;
    let xh = (s3 ^ (s[1] as number)) >>> 0;
    let xl = ((s[2] as number) ^ (s[0] as number)) >>> 0;
    let rot = s3 >>> 26;
    if (rot >= 32) {
      const t = xh;
      xh = xl;
      xl = t;
      rot -= 32;
    }
    if (rot === 0) {
      this.hi = xh;
      this.lo = xl;
    } else {
      this.hi = ((xh >>> rot) | (xl << (32 - rot))) >>> 0;
      this.lo = ((xl >>> rot) | (xh << (32 - rot))) >>> 0;
    }
  }

  /** `random_raw()` as a bigint (tests and the 64-bit Lemire path). */
  nextUint64(): bigint {
    this.nextUint64Parts();
    return (BigInt(this.hi) << 32n) | BigInt(this.lo);
  }

  /** `next_uint32` of the bit generator: low half first, then the buffered high half of the same draw. */
  nextUint32(): number {
    if (this.hasUint32) {
      this.hasUint32 = false;
      return this.uinteger;
    }
    this.nextUint64Parts();
    this.hasUint32 = true;
    this.uinteger = this.hi;
    return this.lo;
  }
}
