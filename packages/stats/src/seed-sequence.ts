/**
 * numpy.random.SeedSequence (numpy/random/bit_generator.pyx, NumPy 2.5.x, BSD-3-Clause; see NOTICE),
 * for an integer entropy and no spawn key: the entropy is split into little-endian 32-bit words, mixed
 * into a 4-word pool, and `generateState` hashes the pool into as many 32-bit words as asked.
 * All arithmetic is modulo 2^32.
 */

const INIT_A = 0x43b0d7e5;
const MULT_A = 0x931e8875;
const INIT_B = 0x8b51f9dd;
const MULT_B = 0x58f38ded;
const MIX_MULT_L = 0xca01f9dd;
const MIX_MULT_R = 0x4973f715;
const XSHIFT = 16;
const POOL_SIZE = 4;

/** `_coerce_to_uint32_array` of an integer: little-endian 32-bit words, `[0]` for zero. */
export function entropyWords(entropy: number | bigint): Uint32Array {
  let v: bigint;
  if (typeof entropy === "bigint") v = entropy;
  else if (Number.isSafeInteger(entropy)) v = BigInt(entropy);
  else throw new RangeError("SeedSequence entropy must be a safe integer or a bigint");
  if (v < 0n) throw new RangeError("SeedSequence entropy must be non-negative");
  const words: number[] = [];
  while (v > 0n) {
    words.push(Number(v & 0xffffffffn));
    v >>= 32n;
  }
  if (words.length === 0) words.push(0);
  return Uint32Array.from(words);
}

export class SeedSequence {
  /** The mixed 4-word pool (`SeedSequence.pool`). */
  readonly pool: Uint32Array;

  constructor(entropy: number | bigint) {
    this.pool = mixEntropy(entropyWords(entropy));
  }

  /** `generate_state(n32 / 2, np.uint64)` viewed as 32-bit words: `n32` words, low word of each uint64 first. */
  generateState(n32: number): Uint32Array {
    const out = new Uint32Array(n32);
    let hashConst = INIT_B;
    for (let i = 0; i < n32; i++) {
      let v = ((this.pool[i % POOL_SIZE] as number) ^ hashConst) >>> 0;
      hashConst = Math.imul(hashConst, MULT_B) >>> 0;
      v = Math.imul(v, hashConst) >>> 0;
      v = (v ^ (v >>> XSHIFT)) >>> 0;
      out[i] = v;
    }
    return out;
  }
}

function mixEntropy(entropy: Uint32Array): Uint32Array {
  const mixer = new Uint32Array(POOL_SIZE);
  const hc = { v: INIT_A };
  for (let i = 0; i < POOL_SIZE; i++) mixer[i] = hashmix(i < entropy.length ? (entropy[i] as number) : 0, hc);
  for (let src = 0; src < POOL_SIZE; src++) {
    for (let dst = 0; dst < POOL_SIZE; dst++) {
      if (src !== dst) mixer[dst] = mix(mixer[dst] as number, hashmix(mixer[src] as number, hc));
    }
  }
  for (let src = POOL_SIZE; src < entropy.length; src++) {
    for (let dst = 0; dst < POOL_SIZE; dst++) mixer[dst] = mix(mixer[dst] as number, hashmix(entropy[src] as number, hc));
  }
  return mixer;
}

function hashmix(value: number, hc: { v: number }): number {
  let v = (value ^ hc.v) >>> 0;
  hc.v = Math.imul(hc.v, MULT_A) >>> 0;
  v = Math.imul(v, hc.v) >>> 0;
  return (v ^ (v >>> XSHIFT)) >>> 0;
}

function mix(x: number, y: number): number {
  const r = (Math.imul(MIX_MULT_L, x) - Math.imul(MIX_MULT_R, y)) >>> 0;
  return (r ^ (r >>> XSHIFT)) >>> 0;
}
