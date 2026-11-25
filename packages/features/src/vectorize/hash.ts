// A pure SHA-256 and the RFC 8785 (JCS) subset the NodeFeatures / FeatureSchema documents need, so that
// `vectorize` can fill `features_id` / `schema_id` identically in Node and in the page without
// node:crypto or the async SubtleCrypto. test/identity.test.ts pins both against @gran-prix/contracts.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** UTF-8 bytes of a string (lone surrogates become U+FFFD, like TextEncoder). No TextEncoder: the pure build has no DOM / Node lib. */
export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      c = 0x10000 + ((c - 0xd800) << 10) + (text.charCodeAt(++i) - 0xdc00);
    } else if (c >= 0xd800 && c <= 0xdfff) {
      c = 0xfffd;
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** SHA-256 of the UTF-8 encoding of `text`, as 64 lowercase hex characters. */
export function sha256Hex(text: string): string {
  const data = utf8(text);
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLen >>> 0, false);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(off + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const w15 = w[t - 15] as number;
      const w2 = w[t - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) | 0;
    }
    let a = h[0] as number, b = h[1] as number, c = h[2] as number, d = h[3] as number;
    let e = h[4] as number, f = h[5] as number, g = h[6] as number, hh = h[7] as number;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[t] as number) + (w[t] as number)) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = ((h[0] as number) + a) | 0; h[1] = ((h[1] as number) + b) | 0;
    h[2] = ((h[2] as number) + c) | 0; h[3] = ((h[3] as number) + d) | 0;
    h[4] = ((h[4] as number) + e) | 0; h[5] = ((h[5] as number) + f) | 0;
    h[6] = ((h[6] as number) + g) | 0; h[7] = ((h[7] as number) + hh) | 0;
  }
  let hex = "";
  for (const v of h) hex += v.toString(16).padStart(8, "0");
  return hex;
}

/**
 * RFC 8785 canonical JSON for plain JSON values. Same rules as the contracts' `canonicalJson` for what
 * this package emits: keys sorted by UTF-16 code units, ECMAScript number formatting, `-0` as `0`,
 * object members whose value is `undefined` omitted. Throws on NaN / Infinity.
 */
export function canonicalJson(value: unknown): string {
  const parts: string[] = [];
  const emit = (v: unknown): void => {
    if (v === null) { parts.push("null"); return; }
    switch (typeof v) {
      case "boolean": parts.push(v ? "true" : "false"); return;
      case "string": parts.push(JSON.stringify(v)); return;
      case "number":
        if (!Number.isFinite(v)) throw new TypeError("canonicalJson: non-finite number");
        parts.push(Object.is(v, -0) ? "0" : String(v));
        return;
      case "object": {
        if (Array.isArray(v)) {
          parts.push("[");
          for (let i = 0; i < v.length; i++) { if (i > 0) parts.push(","); emit(v[i] === undefined ? null : v[i]); }
          parts.push("]");
          return;
        }
        const o = v as Record<string, unknown>;
        const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
        parts.push("{");
        for (let i = 0; i < keys.length; i++) {
          if (i > 0) parts.push(",");
          const k = keys[i] as string;
          parts.push(JSON.stringify(k), ":");
          emit(o[k]);
        }
        parts.push("}");
        return;
      }
      default: throw new TypeError(`canonicalJson: unsupported ${typeof v}`);
    }
  };
  emit(value);
  return parts.join("");
}

/** `sha256:` + hex of the canonical JSON of `value`. */
export function artifactId(value: unknown): `sha256:${string}` {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}
