import {
  checkInputs,
  linearKernel,
  reluInPlace,
  sigmoidInPlace,
  softmaxRowsInPlace,
  tanhInPlace,
} from './kernels.js';
import type { Head } from './networkDef.js';
import { prepareModel, type ExportOptions, type PreparedModel } from './prepare.js';

/** Same surface as a generated module, as an object. */
export interface Predictor {
  readonly inputDim: number;
  readonly outputDim: number;
  readonly head: Head;
  readonly paramCount: number;
  readonly networkDefDigest: string;
  readonly weightsDigest: string;
  /** Raw network output for one sample. */
  predictLogits(input: Float32Array): Float32Array;
  /** Output head applied (sigmoid / softmax / none) for one sample. */
  predictProbs(input: Float32Array): Float32Array;
  /** Raw outputs for `n` row-major samples (`n * outputDim` values). */
  predictLogitsBatch(inputs: Float32Array, n: number): Float32Array;
  /** Head applied for `n` row-major samples (`n * outputDim` values). */
  predictBatch(inputs: Float32Array, n: number): Float32Array;
}

function forward(m: PreparedModel, x: Float32Array, n: number): Float32Array {
  let a: Float32Array = x;
  let owned = false;
  let dim = m.inputDim;
  let linearIdx = 0;
  const own = (): void => {
    if (!owned) {
      a = a.slice();
      owned = true;
    }
  };
  for (const layer of m.def.layers) {
    switch (layer.type) {
      case 'linear': {
        const wOff = m.layout[linearIdx * 2].offset;
        const bOff = m.layout[linearIdx * 2 + 1].offset;
        linearIdx++;
        a = linearKernel(m.weights, a, n, layer.in_features, layer.out_features, wOff, bOff);
        owned = true;
        dim = layer.out_features;
        break;
      }
      case 'activation':
        own();
        if (layer.function === 'relu') reluInPlace(a);
        else if (layer.function === 'tanh') tanhInPlace(a);
        else if (layer.function === 'sigmoid') sigmoidInPlace(a);
        else softmaxRowsInPlace(a, n, dim);
        break;
      case 'dropout':
        break; // identity at inference
      default:
        throw new Error('unreachable: unsupported layer survived parseNetworkDef');
    }
  }
  own();
  return a;
}

function applyHead(m: PreparedModel, a: Float32Array, n: number): Float32Array {
  if (m.head === 'sigmoid') sigmoidInPlace(a);
  else if (m.head === 'softmax') softmaxRowsInPlace(a, n, m.outputDim);
  return a;
}

/**
 * Interpreter with the exact same math as {@link generateInferenceModule}'s
 * output (both run `kernels.ts`), for tests, tooling and the CLI. Not for
 * content scripts: prefer the generated module there.
 */
export function createPredictor(
  networkDef: string | unknown,
  weights: Float32Array | number[],
  opts: ExportOptions = {},
): Predictor {
  const m = prepareModel(networkDef, weights, opts);
  const logitsBatch = (inputs: Float32Array, n: number): Float32Array => {
    checkInputs(inputs, n, m.inputDim, m.checkFinite);
    return forward(m, inputs, n);
  };
  return {
    inputDim: m.inputDim,
    outputDim: m.outputDim,
    head: m.head,
    paramCount: m.paramCount,
    networkDefDigest: m.networkDefDigest,
    weightsDigest: m.weightsDigest,
    predictLogits: (input) => logitsBatch(input, 1),
    predictProbs: (input) => applyHead(m, logitsBatch(input, 1), 1),
    predictLogitsBatch: logitsBatch,
    predictBatch: (inputs, n) => applyHead(m, logitsBatch(inputs, n), n),
  };
}
