import { validate, type Golden } from "@gran-prix/contracts";
import { createPredictor, type Head } from "@gran-prix/infer-ts";
import type { LoadState } from "./checks.js";
import { ModelPackageError, errorText } from "./errors.js";
import { normalizeBatch, scoreFromLogits, scoreFromProbs } from "./output.js";

export interface Tolerance {
  abs: number;
  rel?: number;
}

/** Used only when neither the caller nor golden.json provides a tolerance. */
export const DEFAULT_TOLERANCE: Tolerance = { abs: 1e-5 };

const HEADS = { sigmoid: "sigmoid", softmax: "softmax", identity: "none" } as const satisfies Record<string, Head>;

const fail = (s: LoadState, details: string | string[], cause?: unknown): never => {
  throw new ModelPackageError("golden", s.dir, details, cause === undefined ? undefined : { cause });
};

const within = (got: number, want: number, tol: Tolerance): boolean =>
  Math.abs(got - want) <= tol.abs + (tol.rel ?? 0) * Math.abs(want);

function compare(
  runtime: string,
  what: string,
  got: ArrayLike<number>,
  cases: Golden["cases"],
  pick: (c: Golden["cases"][number]) => readonly number[],
  tol: Tolerance,
  outputDim: number,
): string[] {
  const problems: string[] = [];
  cases.forEach((c, i) => {
    pick(c).forEach((want, k) => {
      const g = got[i * outputDim + k] as number;
      if (!within(g, want, tol)) {
        problems.push(`${runtime} ${what}: case ${c.name ?? i}[${k}] is ${g}, golden has ${want} (|diff| ${Math.abs(g - want).toExponential(2)} > ${tol.abs}${tol.rel ? ` + ${tol.rel}*|want|` : ""})`);
      }
    });
  });
  return problems;
}

/**
 * 9. golden.json reproduces through BOTH runtimes. Inputs are the extractor's
 * output (pre-normalization): `feature_spec.normalization` is applied first.
 * infer-ts reproduces `raw` (logits) and `score`; the WASM Trainer exposes
 * only the activated output, so it is compared on `score` (calibration is
 * re-applied on the recovered logit).
 */
export function checkGolden(s: LoadState, tolerance: Tolerance | undefined): void {
  const m = s.manifest as NonNullable<LoadState["manifest"]>;
  const text = new TextDecoder().decode(s.goldenBytes as Uint8Array);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return fail(s, `golden.json is not valid JSON: ${errorText(e)}`, e);
  }
  const g = validate("golden", doc);
  if (!g.ok) return fail(s, g.issues.slice(0, 8).map((i) => `${i.code} ${i.path}: ${i.message}`));
  const golden = g.value;
  s.golden = golden;
  if (golden.weights_sha256 !== m.digest.weights) {
    fail(s, `golden.json was produced from weights ${golden.weights_sha256}, model.json declares ${m.digest.weights}`);
  }
  const dim = m.feature_spec.dim;
  const outDim = m.network.output_dim;
  const shape: string[] = [];
  golden.cases.forEach((c, i) => {
    if (c.input.length !== dim) shape.push(`case ${c.name ?? i}: input has ${c.input.length} values, feature_spec.dim is ${dim}`);
    if (c.raw.length !== outDim) shape.push(`case ${c.name ?? i}: raw has ${c.raw.length} values, output_dim is ${outDim}`);
  });
  if (shape.length > 0) fail(s, shape);

  const tol = tolerance ?? golden.tolerance ?? DEFAULT_TOLERANCE;
  const n = golden.cases.length;
  const x = normalizeBatch(m.feature_spec, golden.cases.flatMap((c) => c.input), n);

  const problems: string[] = [];

  // infer-ts
  try {
    const predictor = createPredictor(s.networkDef, s.weights as Float32Array, {
      head: HEADS[m.output_spec.activation],
      paramShapes: (s.trainer as NonNullable<LoadState["trainer"]>).paramShapes(),
    });
    const raw = predictor.predictLogitsBatch(x, n);
    const score = scoreFromLogits(m.output_spec, raw, n, outDim);
    problems.push(
      ...compare("infer-ts", "raw", raw, golden.cases, (c) => c.raw, tol, outDim),
      ...compare("infer-ts", "score", score, golden.cases, (c) => c.score, tol, outDim),
    );
    s.predictor = predictor;
  } catch (e) {
    problems.push(`infer-ts cannot run this network: ${errorText(e)}`);
  }

  // WASM Trainer (weights already imported by check 8)
  if (m.output_spec.activation === "identity") {
    s.warnings.push("output_spec.activation is identity: the WASM Trainer always applies sigmoid/softmax, so it was not compared against golden.json");
  } else {
    try {
      const probs = (s.trainer as NonNullable<LoadState["trainer"]>).predictProbsBatch(x, n);
      const score = scoreFromProbs(m.output_spec, probs, n, outDim);
      problems.push(...compare("wasm", "score", score, golden.cases, (c) => c.score, tol, outDim));
    } catch (e) {
      problems.push(`wasm Trainer failed on the golden inputs: ${errorText(e)}`);
    }
  }
  if (problems.length > 0) fail(s, problems);
}

/** Maps `output_spec.activation` to the infer-ts head. */
export const headOf = (activation: keyof typeof HEADS): Head => HEADS[activation];
