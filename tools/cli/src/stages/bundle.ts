import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Of, type ModelPackage, type Sha256 } from "@gran-prix/contracts";
import { generateInferenceModule, type Head, type ParamShape } from "@gran-prix/infer-ts";

/** File name of the generated inference module inside a bundle. */
export const GENERATED_MODULE = "model.generated.ts";
export const SELFTEST = "selftest.mjs";
export const BUNDLE_JSON = "bundle.json";

const HEADS = { sigmoid: "sigmoid", softmax: "softmax", identity: "none" } as const satisfies Record<string, Head>;

/**
 * Standalone self-test shipped inside every bundle. It needs only Node (type
 * stripping: Node >= 22.18, or `node --experimental-strip-types selftest.mjs` on
 * 22.6+): it normalizes golden.json's inputs with `feature_spec`, runs them
 * through `model.generated.ts`, applies calibration and the output head, and
 * compares `raw` and `score` with golden.json within its tolerance.
 */
export const SELFTEST_SOURCE = `// Self-test of this bundle (written by \`gp\`; do not edit).
// Runs golden.json through model.generated.ts. Needs Node >= 22.18, or:
//   node --experimental-strip-types selftest.mjs
import { readFileSync } from "node:fs";

const json = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
const model = json("model.json");
const golden = json("golden.json");
const gen = await import("./${GENERATED_MODULE}");

const spec = model.feature_spec;
const norm = spec.normalization;
const n = golden.cases.length;
const x = new Float32Array(n * spec.dim);
golden.cases.forEach((c, r) => {
  c.input.forEach((v, i) => {
    x[r * spec.dim + i] = norm.kind === "zscore" ? (v - norm.mean[i]) / (norm.std[i] + norm.eps) : v;
  });
});

const raw = gen.predictLogitsBatch(x, n);
const out = model.output_spec;
const k = gen.OUTPUT_DIM;
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const score = (row) => {
  const z = row.slice();
  if (out.activation === "sigmoid") {
    z[0] = sigmoid(out.calibration.kind === "platt" ? out.calibration.a * z[0] + out.calibration.b : z[0]);
    return z;
  }
  if (out.calibration.kind === "temperature") for (let i = 0; i < k; i++) z[i] /= out.calibration.t;
  if (out.activation !== "softmax") return z;
  const max = Math.max(...z);
  const e = z.map((v) => Math.exp(v - max));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
};

const tol = golden.tolerance;
const problems = [];
let maxRaw = 0;
let maxScore = 0;
golden.cases.forEach((c, r) => {
  const got = Array.from(raw.subarray(r * k, (r + 1) * k));
  const sc = score(got);
  for (let i = 0; i < k; i++) {
    for (const [what, g, w] of [["raw", got[i], c.raw[i]], ["score", sc[i], c.score[i]]]) {
      const d = Math.abs(g - w);
      if (what === "raw") maxRaw = Math.max(maxRaw, d); else maxScore = Math.max(maxScore, d);
      if (!(d <= tol.abs + (tol.rel ?? 0) * Math.abs(w))) problems.push(\`case \${c.name ?? r} \${what}[\${i}]: got \${g}, golden has \${w}\`);
    }
  }
});
if (gen.WEIGHTS_DIGEST !== model.digest.weights) problems.push("model.generated.ts embeds other weights than model.json");

if (problems.length > 0) {
  console.error(\`selftest: FAIL\\n  \${problems.join("\\n  ")}\`);
  process.exit(1);
}
console.log(\`selftest: PASS (\${n} cases, max |raw diff| \${maxRaw.toExponential(2)}, max |score diff| \${maxScore.toExponential(2)})\`);
`;

const TINY_DEF = {
  input_dim: 2,
  layers: [
    { type: "linear", in_features: 2, out_features: 2 },
    { type: "activation", function: "tanh" },
    { type: "linear", in_features: 2, out_features: 1 },
  ],
};

/**
 * sha256 of the module the generator emits for a fixed tiny network: it changes
 * whenever `@gran-prix/infer-ts` changes what it generates (code, kernels, header),
 * so it belongs to the cache key of the stage that embeds that output.
 */
export function generatorDigest(): Sha256 {
  const weights = Float32Array.from({ length: 9 }, (_, i) => (i + 1) / 16);
  return sha256Of(new TextEncoder().encode(generateInferenceModule(TINY_DEF, weights, { head: "sigmoid" })));
}

/** f32 little-endian bytes -> Float32Array (a copy: the input may be unaligned). */
export function decodeF32le(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Generates `model.generated.ts` from the package's own network_def, weights and output head. */
export function generateModule(manifest: ModelPackage, networkDefText: string, weightsBytes: Uint8Array): string {
  const paramShapes: ParamShape[] = manifest.network.param_layout.map((l) => ({
    name: l.name,
    shape: [...l.shape],
    offset: l.offset,
    len: l.length,
  }));
  return generateInferenceModule(networkDefText, decodeF32le(weightsBytes), {
    head: HEADS[manifest.output_spec.activation],
    paramShapes,
  });
}

const enc = (v: Uint8Array | string): Uint8Array => (typeof v === "string" ? new TextEncoder().encode(v) : v);

/** Runs the bundle's self-test (the real files, in a scratch directory, in a child Node). */
export function runSelfTest(files: Readonly<Record<string, Uint8Array | string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "gp-bundle-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = join(dir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const env = { ...process.env };
    delete env["NODE_OPTIONS"];
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", SELFTEST], { cwd: dir, encoding: "utf8", env });
    if (r.error) throw new Error(`bundle self-test could not start: ${r.error.message}`);
    if (r.status !== 0) {
      throw new Error(`bundle self-test failed (exit ${String(r.status ?? r.signal)}): ${(r.stderr || r.stdout).trim().slice(-2000)}`);
    }
    return r.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface BundleDoc {
  format: "gran-prix.bundle";
  format_version: "1.0.0";
  model_id: Sha256;
  name: string;
  entry: string;
  files: Record<string, { sha256: Sha256; bytes: number }>;
  self_test: { command: string; cases: number; tolerance: { abs: number; rel?: number }; passed: true };
}

/** `bundle.json`: sha256 and size of every other file, sorted by path (deterministic). */
export function bundleDoc(
  manifest: ModelPackage,
  modelId: Sha256,
  files: Readonly<Record<string, Uint8Array | string>>,
  golden: { cases: unknown[]; tolerance: { abs: number; rel?: number } },
): BundleDoc {
  const entries = Object.keys(files)
    .sort()
    .map((p) => {
      const bytes = enc(files[p] as Uint8Array | string);
      return [p, { sha256: sha256Of(bytes), bytes: bytes.byteLength }] as const;
    });
  return {
    format: "gran-prix.bundle",
    format_version: "1.0.0",
    model_id: modelId,
    name: manifest.name,
    entry: GENERATED_MODULE,
    files: Object.fromEntries(entries),
    self_test: { command: `node ${SELFTEST}`, cases: golden.cases.length, tolerance: golden.tolerance, passed: true },
  };
}
