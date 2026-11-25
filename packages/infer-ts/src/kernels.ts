/**
 * Numeric kernels shared by the interpreter (`createPredictor`) and by every
 * generated inference module.
 *
 * SINGLE SOURCE OF TRUTH: this file is embedded verbatim (minus the `export `
 * keywords) into the generated modules by `scripts/embed-kernels.mjs`, which
 * writes `kernelsSource.ts`. A test fails when the two drift apart. Because
 * generated code and interpreter run the exact same text, they agree bit for
 * bit.
 *
 * Constraints (so the text can be pasted into any module):
 *  - no imports, no references to anything outside this file;
 *  - strict-mode TypeScript that also compiles under `noUnusedLocals`;
 *  - only plain function declarations at the top level, each preceded by a
 *    doc comment and separated from the next by exactly one blank line, with
 *    no blank lines inside a function (the embedder splits on blank lines so
 *    that a generated module only contains the kernels it actually uses).
 *
 * Layout conventions (match gran-prix `Linear`): a weight matrix is row-major
 * `[in, out]`, a bias is `[1, out]`, activations are row-major `[n, dim]`.
 */

/** Decodes a standard base64 string of `count` little-endian f32 values. */
export function decodeWeights(b64: string, count: number): Float32Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lut = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) lut[alphabet.charCodeAt(i)] = i;
  const bytes = new Uint8Array(count * 4);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < b64.length && o < bytes.length; i++) {
    const c = b64.charCodeAt(i);
    if (c === 61) break; // '=' padding
    const v = c < 128 ? lut[c] : -1;
    if (v < 0) throw new Error('invalid base64 character in embedded weights');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[o++] = (acc >> bits) & 0xff;
    }
  }
  if (o !== bytes.length) throw new Error('embedded weights are shorter than expected');
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Throws unless `inputs` holds exactly `n` finite rows of `inputDim` values. */
export function checkInputs(inputs: ArrayLike<number>, n: number, inputDim: number, finite: boolean): void {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('batch size must be a non-negative integer');
  if (inputs.length !== n * inputDim) {
    throw new RangeError('inputs length ' + inputs.length + ' != n ' + n + ' * inputDim ' + inputDim);
  }
  if (finite) {
    for (let i = 0; i < inputs.length; i++) {
      if (!Number.isFinite(inputs[i])) throw new RangeError('inputs[' + i + '] is not finite');
    }
  }
}

/** `y = x @ W + b` for `n` rows; returns a fresh `[n, outD]` array. */
export function linearKernel(
  W: Float32Array,
  x: Float32Array,
  n: number,
  inD: number,
  outD: number,
  wOff: number,
  bOff: number,
): Float32Array {
  const y = new Float32Array(n * outD);
  for (let r = 0; r < n; r++) {
    const yo = r * outD;
    const xo = r * inD;
    for (let o = 0; o < outD; o++) y[yo + o] = W[bOff + o];
    for (let i = 0; i < inD; i++) {
      const xi = x[xo + i];
      const wo = wOff + i * outD;
      for (let o = 0; o < outD; o++) y[yo + o] += xi * W[wo + o];
    }
  }
  return y;
}

/** ReLU: max(0, x). */
export function reluInPlace(a: Float32Array): void {
  for (let i = 0; i < a.length; i++) if (!(a[i] > 0)) a[i] = 0;
}

/** Hyperbolic tangent. */
export function tanhInPlace(a: Float32Array): void {
  for (let i = 0; i < a.length; i++) a[i] = Math.tanh(a[i]);
}

/** Logistic sigmoid. */
export function sigmoidInPlace(a: Float32Array): void {
  for (let i = 0; i < a.length; i++) a[i] = 1 / (1 + Math.exp(-a[i]));
}

/** Numerically stable row-wise softmax over `n` rows of `d` values. */
export function softmaxRowsInPlace(a: Float32Array, n: number, d: number): void {
  for (let r = 0; r < n; r++) {
    const o = r * d;
    let max = -Infinity;
    for (let c = 0; c < d; c++) if (a[o + c] > max) max = a[o + c];
    let sum = 0;
    for (let c = 0; c < d; c++) {
      const e = Math.exp(a[o + c] - max);
      a[o + c] = e;
      sum += e;
    }
    if (!(sum > 1e-10)) sum = 1e-10;
    for (let c = 0; c < d; c++) a[o + c] /= sum;
  }
}
