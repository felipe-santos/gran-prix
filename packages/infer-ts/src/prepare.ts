import { base64Encode, f32leBytes, networkDefDigest, sha256Hex } from './digest.js';
import {
  assertLayoutMatches,
  outputDim,
  paramLayout,
  parseNetworkDef,
  resolveHead,
  type Head,
  type NetworkDef,
  type ParamShape,
} from './networkDef.js';

export interface ExportOptions {
  /**
   * Output head applied by `predictProbs` / `predictBatch`. `'auto'` (default)
   * mirrors the WASM Trainer: sigmoid when the network has one output,
   * softmax otherwise. `'none'` leaves the logits untouched. Use `'sigmoid'`
   * for several independent binary heads (`fromNetworkDefWithLoss(BCE)`).
   */
  head?: Head | 'auto';
  /** Reject NaN/Infinity inputs at runtime (default true, like the WASM predict* methods). */
  checkFinite?: boolean;
  /**
   * Optional cross-check: the `paramShapes()` of the WASM Trainer that produced
   * the weights. When given, the layout derived from the NetworkDef must match
   * it exactly, otherwise preparation throws.
   */
  paramShapes?: ParamShape[];
}

/** Everything the generator and the interpreter derive from (NetworkDef, weights). */
export interface PreparedModel {
  def: NetworkDef;
  layout: ParamShape[];
  weights: Float32Array;
  inputDim: number;
  outputDim: number;
  head: Head;
  checkFinite: boolean;
  paramCount: number;
  networkDefDigest: string;
  weightsDigest: string;
  weightsBase64: string;
}

/** Validates the pair and computes layout, digests and the embedded blob. */
export function prepareModel(
  networkDef: string | unknown,
  weights: Float32Array | number[],
  opts: ExportOptions = {},
): PreparedModel {
  const def = parseNetworkDef(networkDef);
  const layout = paramLayout(def);
  if (opts.paramShapes) assertLayoutMatches(layout, opts.paramShapes);

  const paramCount = layout.reduce((n, p) => n + p.len, 0);
  if (weights.length !== paramCount) {
    throw new Error(`weights length ${weights.length} != parameter count ${paramCount} implied by the NetworkDef`);
  }
  const f32 = Float32Array.from(weights);
  for (let i = 0; i < f32.length; i++) {
    if (!Number.isFinite(f32[i])) throw new Error(`weights[${i}] is not finite`);
  }

  const bytes = f32leBytes(f32);
  const outDim = outputDim(def);
  return {
    def,
    layout,
    weights: f32,
    inputDim: def.input_dim,
    outputDim: outDim,
    head: resolveHead(opts.head, outDim),
    checkFinite: opts.checkFinite ?? true,
    paramCount,
    networkDefDigest: networkDefDigest(def),
    weightsDigest: 'sha256:' + sha256Hex(bytes),
    weightsBase64: base64Encode(bytes),
  };
}
