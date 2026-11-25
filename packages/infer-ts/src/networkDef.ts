/**
 * TypeScript view of gran-prix's `NetworkDef` (src/network_def.rs) plus the
 * layout rules needed to slice a flat weight vector.
 *
 * Supported layers for TS export: `linear`, `activation` (relu, tanh, sigmoid,
 * softmax) and `dropout` (identity at inference). Everything else is rejected
 * with {@link UnsupportedLayerError}; see the README for the reasons.
 */

export type ActivationFunction = 'relu' | 'tanh' | 'sigmoid' | 'softmax';

export type LayerDef =
  | { type: 'linear'; in_features: number; out_features: number }
  | { type: 'activation'; function: ActivationFunction }
  | { type: 'dropout'; rate: number }
  | { type: 'batchnorm'; num_features: number }
  | { type: 'rnn'; input_size: number; hidden_size: number }
  | { type: 'gru'; input_size: number; hidden_size: number };

export interface NetworkDef {
  input_dim: number;
  layers: LayerDef[];
}

/** One parameter inside the flat weight vector (same shape as WASM `paramShapes()`). */
export interface ParamShape {
  name: string;
  shape: number[];
  offset: number;
  len: number;
}

/** Thrown for layers (or activation names) the TS exporter does not implement. */
export class UnsupportedLayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedLayerError';
  }
}

const UNSUPPORTED_REASONS: Record<string, string> = {
  batchnorm:
    'BatchNorm has no running statistics in gran-prix: it normalizes with the statistics of the batch ' +
    'it is given (batch of 1 falls back to the affine transform), so its output depends on the batch ' +
    'composition and cannot be reproduced by a stateless exporter. Train without BatchNorm, or wait for ' +
    'running-statistics support',
  rnn: 'RNN layers carry hidden state between calls, which a stateless predictLogits() cannot express (not supported in v0)',
  gru: 'GRU layers carry hidden state between calls, which a stateless predictLogits() cannot express (not supported in v0)',
};

const ACTIVATIONS = new Set<string>(['relu', 'tanh', 'sigmoid', 'softmax']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isDim(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Parses and validates a `NetworkDef` JSON string (or already-parsed object),
 * mirroring `NetworkDef::validate`, and rejects unsupported layers.
 * Throws `Error` for malformed definitions and `UnsupportedLayerError` for
 * valid ones this exporter cannot reproduce.
 */
export function parseNetworkDef(json: string | unknown): NetworkDef {
  let raw: unknown = json;
  if (typeof json === 'string') {
    try {
      raw = JSON.parse(json);
    } catch (e) {
      throw new Error('NetworkDef: invalid JSON: ' + (e instanceof Error ? e.message : String(e)));
    }
  }
  if (!isObject(raw)) throw new Error('NetworkDef: expected an object');
  if (!isDim(raw.input_dim)) throw new Error('NetworkDef: input_dim must be a positive integer');
  if (!Array.isArray(raw.layers) || raw.layers.length === 0) {
    throw new Error('NetworkDef: must have at least one layer');
  }

  let dim: number = raw.input_dim;
  const layers: LayerDef[] = [];
  raw.layers.forEach((l: unknown, i: number) => {
    if (!isObject(l) || typeof l.type !== 'string') throw new Error(`NetworkDef: layer ${i} has no "type"`);
    const where = `layers[${i}]`;
    switch (l.type) {
      case 'linear': {
        if (!isDim(l.in_features) || !isDim(l.out_features)) {
          throw new Error(`NetworkDef: ${where} linear needs positive integer in_features/out_features`);
        }
        if (l.in_features !== dim) {
          throw new Error(`NetworkDef: layer ${i} expects input_dim=${l.in_features}, but previous output is ${dim}`);
        }
        layers.push({ type: 'linear', in_features: l.in_features, out_features: l.out_features });
        dim = l.out_features;
        break;
      }
      case 'activation': {
        if (typeof l.function !== 'string' || !ACTIVATIONS.has(l.function)) {
          throw new UnsupportedLayerError(
            `unsupported layer for TS export: ${where} activation "${String(l.function)}" ` +
              `(supported: ${[...ACTIVATIONS].join(', ')})`,
          );
        }
        layers.push({ type: 'activation', function: l.function as ActivationFunction });
        break;
      }
      case 'dropout': {
        const rate = l.rate;
        if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate >= 1) {
          throw new Error(`NetworkDef: layer ${i} has invalid dropout rate ${String(rate)}; expected finite value in [0, 1)`);
        }
        layers.push({ type: 'dropout', rate });
        break;
      }
      default: {
        const reason = UNSUPPORTED_REASONS[l.type];
        throw new UnsupportedLayerError(
          `unsupported layer for TS export: ${where} is "${l.type}"` + (reason ? `. ${reason}` : ' (unknown layer type)'),
        );
      }
    }
  });
  return { input_dim: raw.input_dim, layers };
}

/** Output dimension of a validated definition. */
export function outputDim(def: NetworkDef): number {
  let dim = def.input_dim;
  for (const l of def.layers) if (l.type === 'linear') dim = l.out_features;
  return dim;
}

/**
 * Parameter layout of a supported definition, in the registration order used
 * by `ParamStore::export_flat`: per `linear` layer `i`, `layers[i].weight`
 * (`[in, out]`, row-major) then `layers[i].bias` (`[1, out]`).
 */
export function paramLayout(def: NetworkDef): ParamShape[] {
  const out: ParamShape[] = [];
  let offset = 0;
  def.layers.forEach((l, i) => {
    if (l.type !== 'linear') return;
    const w = l.in_features * l.out_features;
    out.push({ name: `layers[${i}].weight`, shape: [l.in_features, l.out_features], offset, len: w });
    offset += w;
    out.push({ name: `layers[${i}].bias`, shape: [1, l.out_features], offset, len: l.out_features });
    offset += l.out_features;
  });
  return out;
}

/** Throws when `actual` (e.g. WASM `paramShapes()`) disagrees with the layout rules. */
export function assertLayoutMatches(expected: ParamShape[], actual: ParamShape[]): void {
  if (expected.length !== actual.length) {
    throw new Error(`param layout mismatch: expected ${expected.length} parameters, got ${actual.length}`);
  }
  expected.forEach((e, i) => {
    const a = actual[i];
    const same =
      e.name === a.name &&
      e.offset === a.offset &&
      e.len === a.len &&
      e.shape.length === a.shape.length &&
      e.shape.every((d, k) => d === a.shape[k]);
    if (!same) {
      throw new Error(
        `param layout mismatch at #${i}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`,
      );
    }
  });
}

/** Default output head, mirroring the WASM Trainer: sigmoid for 1 output, softmax otherwise. */
export type Head = 'sigmoid' | 'softmax' | 'none';

export function resolveHead(head: Head | 'auto' | undefined, outDim: number): Head {
  if (head === undefined || head === 'auto') return outDim === 1 ? 'sigmoid' : 'softmax';
  return head;
}
