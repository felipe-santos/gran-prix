import { stripTypeScriptTypes } from "node:module";
import type { ModelPackage } from "@gran-prix/contracts";
import { generateModule } from "../bundle.js";

/**
 * The model as the page runs it: the SAME self-contained module `gp package` ships (`model.generated.ts` of
 * `@gran-prix/infer-ts`, no imports, no WASM, no eval) with its types stripped, plus what the extension does around it
 * (z-score of `feature_spec`, calibration and activation of `output_spec`, as `@gran-prix/model` does in Node).
 */

export interface ModelFiles {
  file(path: string): Uint8Array;
}

/** What the in-page runner needs besides the network: the normalization and the output stage. */
export interface PageSpec {
  dim: number;
  outputDim: number;
  normalization: ModelPackage["feature_spec"]["normalization"];
  activation: ModelPackage["output_spec"]["activation"];
  calibration: ModelPackage["output_spec"]["calibration"];
}

/** Sizes of the pieces, in bytes. */
export interface ModelSizes {
  weights_bytes: number;
  network_def_bytes: number;
  model_json_bytes: number;
  golden_bytes: number;
  /** `model.generated.ts` as the bundle carries it (weights as base64 plus the kernels). */
  generated_ts_bytes: number;
  /** weights.f32le + network_def.json + model.json: the information content of the package without the test vectors. */
  package_bytes: number;
  /** model.generated.ts + model.json: what an extension would embed (the weights travel inside the generated module). */
  extension_bytes: number;
  /** All four files of the ModelPackage directory. */
  full_package_bytes: number;
  param_count: number;
}

export interface PageModel {
  /** Body of a function that evaluates the generated module and returns `{ predictLogitsBatch }`. */
  moduleBody: string;
  spec: PageSpec;
  sizes: ModelSizes;
  manifest: ModelPackage;
  /** `[inputDim, ...hidden widths, outputDim]`, from the network definition. */
  shape: number[];
}

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

interface LayerLike {
  type: string;
  out_features?: number;
}

export function buildPageModel(files: ModelFiles): PageModel {
  const manifest = JSON.parse(text(files.file("model.json"))) as ModelPackage;
  const defText = text(files.file(manifest.files.network_def.path));
  const weights = files.file(manifest.files.weights.path);
  const golden = files.file(manifest.files.golden.path);
  const ts = generateModule(manifest, defText, weights);
  // Types are blanked in place; `export` is dropped so the body can run inside a Function and hand its API back.
  const js = stripTypeScriptTypes(ts).replace(/^export /gm, "");
  const moduleBody = `${js}\nreturn { predictLogitsBatch, INPUT_DIM, OUTPUT_DIM };`;

  const def = JSON.parse(defText) as { layers: LayerLike[] };
  const shape = [manifest.network.input_dim, ...def.layers.filter((l) => l.type === "linear").map((l) => l.out_features as number)];
  const modelJson = files.file("model.json").byteLength;
  const sizes: ModelSizes = {
    weights_bytes: weights.byteLength,
    network_def_bytes: Buffer.byteLength(defText),
    model_json_bytes: modelJson,
    golden_bytes: golden.byteLength,
    generated_ts_bytes: Buffer.byteLength(ts),
    package_bytes: weights.byteLength + Buffer.byteLength(defText) + modelJson,
    extension_bytes: Buffer.byteLength(ts) + modelJson,
    full_package_bytes: weights.byteLength + Buffer.byteLength(defText) + modelJson + golden.byteLength,
    param_count: manifest.files.weights.count,
  };
  return {
    moduleBody,
    spec: {
      dim: manifest.feature_spec.dim,
      outputDim: manifest.network.output_dim,
      normalization: manifest.feature_spec.normalization,
      activation: manifest.output_spec.activation,
      calibration: manifest.output_spec.calibration,
    },
    sizes,
    manifest,
    shape,
  };
}
