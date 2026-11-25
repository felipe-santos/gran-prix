/**
 * Unsigned 32x32 -> 64 multiplication on plain numbers. `mul32` returns the low word and leaves the
 * high word in `MUL_HI` (a live binding: read it right after the call). Allocation free.
 */
export let MUL_HI = 0;

export function mul32(a: number, b: number): number {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  const p00 = a0 * b0;
  const mid = a0 * b1 + a1 * b0 + (p00 >>> 16); // < 2^34: exact
  MUL_HI = a1 * b1 + Math.floor(mid / 65536);
  return Math.imul(a, b) >>> 0;
}
