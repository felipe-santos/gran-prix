import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  artifactId,
  canonicalJson,
  sha256Of,
  validate,
  type ContractIssue,
  type Golden,
  type ModelPackage,
} from "@gran-prix/contracts";
import type { Predictor } from "@gran-prix/infer-ts";
import { ModelPackageError, errorText, type CheckId } from "./errors.js";
import type { WasmApi, WasmTrainerApi, WasmValidation } from "./wasm.js";

/** ABIs this loader understands (`requires.runtime.wasm_abi`). */
export const SUPPORTED_WASM_ABIS: readonly string[] = ["gran-prix-wasm@0.1"];

/** Everything the checks accumulate; later checks read what earlier ones established. */
export interface LoadState {
  dir: string;
  wasm: WasmApi;
  supportedAbis: readonly string[];
  manifest?: ModelPackage;
  networkDefText?: string;
  networkDef?: unknown;
  weightsBytes?: Uint8Array;
  goldenBytes?: Uint8Array;
  golden?: Golden;
  validation?: WasmValidation;
  weights?: Float32Array;
  /** Trainer used for paramShapes / round-trip; kept alive for the `wasm` runtime. */
  trainer?: WasmTrainerApi;
  /** infer-ts interpreter built by check 9. */
  predictor?: Predictor;
  warnings: string[];
}

export type CheckFn = (s: LoadState) => void;

const fail = (s: LoadState, check: CheckId, details: string | string[], cause?: unknown): never => {
  throw new ModelPackageError(check, s.dir, details, cause === undefined ? undefined : { cause });
};

function issueLines(issues: readonly ContractIssue[]): string[] {
  return issues.slice(0, 8).map((i) => `${i.code} ${i.path}: ${i.message}`);
}

function readFile(s: LoadState, check: CheckId, name: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(join(s.dir, name)));
  } catch (e) {
    return fail(s, check, `cannot read ${name}: ${errorText(e)}`, e);
  }
}

function parseJson(s: LoadState, check: CheckId, name: string, content: Uint8Array | string): unknown {
  try {
    return JSON.parse(typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch (e) {
    return fail(s, check, `${name} is not valid JSON: ${errorText(e)}`, e);
  }
}

const mf = (s: LoadState): ModelPackage => s.manifest as ModelPackage;

/** 1. model.json validates with the contracts (and asks for nothing this loader does not know). */
export const checkManifest: CheckFn = (s) => {
  const bytes = readFile(s, "manifest", "model.json");
  const doc = parseJson(s, "manifest", "model.json", bytes);
  const r = validate("model-package", doc);
  if (!r.ok) fail(s, "manifest", issueLines(r.issues));
  const m = r.ok ? r.value : (doc as ModelPackage);
  if (m.requires.extensions.length > 0) {
    fail(s, "manifest", `requires unknown extension(s): ${m.requires.extensions.join(", ")}`);
  }
  if (!s.supportedAbis.includes(m.requires.runtime.wasm_abi)) {
    fail(s, "manifest", `requires wasm_abi "${m.requires.runtime.wasm_abi}"; this loader supports ${s.supportedAbis.join(", ")}`);
  }
  s.manifest = m;
};

/** 2. Every referenced file exists with the declared byte size. */
export const checkFiles: CheckFn = (s) => {
  const problems: string[] = [];
  for (const [role, f] of Object.entries(mf(s).files)) {
    const path = join(s.dir, f.path);
    if (!existsSync(path)) {
      problems.push(`${f.path} (${role}) does not exist`);
      continue;
    }
    const size = statSync(path).size;
    if (size !== f.bytes) problems.push(`${f.path} (${role}) is ${size} bytes, model.json declares ${f.bytes}`);
  }
  if (problems.length > 0) fail(s, "files", problems);
  const m = mf(s);
  s.networkDefText = new TextDecoder().decode(readFile(s, "files", m.files.network_def.path));
  s.weightsBytes = readFile(s, "files", m.files.weights.path);
  s.goldenBytes = readFile(s, "files", m.files.golden.path);
};

/** 3. sha256 of weights.f32le and golden.json (raw bytes) match model.json. */
export const checkDigests: CheckFn = (s) => {
  const m = mf(s);
  const problems: string[] = [];
  const weights = sha256Of(s.weightsBytes as Uint8Array);
  const golden = sha256Of(s.goldenBytes as Uint8Array);
  if (weights !== m.digest.weights) problems.push(`${m.files.weights.path}: sha256 is ${weights}, model.json declares ${m.digest.weights}`);
  if (golden !== m.digest.golden) problems.push(`${m.files.golden.path}: sha256 is ${golden}, model.json declares ${m.digest.golden}`);
  if (problems.length > 0) fail(s, "digests", problems);
};

/** 4. digest.network_def equals the RFC 8785 hash of the parsed network_def.json. */
export const checkNetworkDefDigest: CheckFn = (s) => {
  const m = mf(s);
  const parsed = parseJson(s, "network-def-digest", m.files.network_def.path, s.networkDefText as string);
  s.networkDef = parsed;
  const id = artifactId(parsed);
  if (id !== m.digest.network_def) {
    fail(s, "network-def-digest", `canonical hash of ${m.files.network_def.path} is ${id}, model.json declares ${m.digest.network_def}`);
  }
};

/** 5. validateNetworkDef (WASM) is ok, and `requires.layer_types` lists the layers actually used. */
export const checkNetworkDefValid: CheckFn = (s) => {
  let v: WasmValidation;
  try {
    v = s.wasm.validateNetworkDef(s.networkDefText as string);
  } catch (e) {
    return fail(s, "network-def-valid", `validateNetworkDef threw: ${errorText(e)}`, e);
  }
  if (!v.ok) fail(s, "network-def-valid", v.errors.length > 0 ? v.errors : ["validateNetworkDef returned ok=false"]);
  s.validation = v;
  const layers = ((s.networkDef as { layers?: Array<{ type?: string }> }).layers ?? []).map((l) => l.type ?? "?");
  const declared = new Set<string>(mf(s).requires.layer_types);
  const undeclared = [...new Set(layers)].filter((t) => !declared.has(t));
  if (undeclared.length > 0) {
    fail(s, "network-def-valid", `network uses layer type(s) ${undeclared.join(", ")} not listed in requires.layer_types`);
  }
};

/** 6. input_dim == feature_spec.dim; output dimension consistent with output_spec. */
export const checkDimensions: CheckFn = (s) => {
  const m = mf(s);
  const v = s.validation as WasmValidation;
  const problems: string[] = [];
  if (v.inputDim !== m.network.input_dim) problems.push(`network_def input_dim is ${v.inputDim}, model.json network.input_dim is ${m.network.input_dim}`);
  if (v.inputDim !== m.feature_spec.dim) problems.push(`network_def input_dim is ${v.inputDim}, feature_spec.dim is ${m.feature_spec.dim}`);
  if (v.outputDim !== m.network.output_dim) problems.push(`network_def output dimension is ${v.outputDim}, model.json network.output_dim is ${m.network.output_dim}`);
  const os = m.output_spec;
  if (os.activation === "sigmoid" && v.outputDim !== 1) problems.push(`output_spec.activation is sigmoid (one logit) but the network has ${v.outputDim} outputs`);
  if (os.activation !== "sigmoid" && v.outputDim !== os.labels.length) problems.push(`output_spec has ${os.labels.length} labels but the network has ${v.outputDim} outputs`);
  if (problems.length > 0) fail(s, "dimensions", problems);
};

/** 7. weights length == paramCount, and param_layout == Trainer.paramShapes(). */
export const checkWeightsLayout: CheckFn = (s) => {
  const m = mf(s);
  const bytes = s.weightsBytes as Uint8Array;
  const count = bytes.byteLength / 4;
  const problems: string[] = [];
  if (bytes.byteLength % 4 !== 0) problems.push(`${m.files.weights.path} has ${bytes.byteLength} bytes, not a multiple of 4`);
  const v = s.validation as WasmValidation;
  if (count !== v.paramCount) problems.push(`weights hold ${count} floats, validateNetworkDef reports paramCount ${v.paramCount}`);
  let trainer: WasmTrainerApi;
  try {
    trainer = s.wasm.Trainer.fromNetworkDef(s.networkDefText as string);
  } catch (e) {
    return fail(s, "weights-layout", `Trainer.fromNetworkDef failed: ${errorText(e)}`, e);
  }
  s.trainer = trainer;
  const total = trainer.get_weights().length; // Trainer.paramCount() counts tensors, not floats
  if (total !== count) problems.push(`weights hold ${count} floats, the Trainer has ${total} parameters`);
  const shapes = trainer.paramShapes();
  if (shapes.length !== m.network.param_layout.length) {
    problems.push(`param_layout has ${m.network.param_layout.length} entries, paramShapes() has ${shapes.length}`);
  }
  shapes.forEach((p, i) => {
    const l = m.network.param_layout[i];
    if (!l) return;
    const same = l.name === p.name && l.offset === p.offset && l.length === p.len && l.shape.length === p.shape.length && l.shape.every((d, k) => d === p.shape[k]);
    if (!same) {
      problems.push(
        `param_layout[${i}] is ${l.name} [${l.shape.join(",")}] @${l.offset}+${l.length}, paramShapes()[${i}] is ${p.name} [${p.shape.join(",")}] @${p.offset}+${p.len}`,
      );
    }
  });
  if (count !== m.files.weights.count) problems.push(`weights hold ${count} floats, files.weights.count is ${m.files.weights.count}`);
  if (problems.length > 0) fail(s, "weights-layout", problems);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const weights = new Float32Array(count);
  for (let i = 0; i < count; i++) weights[i] = view.getFloat32(i * 4, true);
  s.weights = weights;
};

/** 8. Round trip: Trainer.fromNetworkDef + import_weights, then networkDefJson() is semantically the file. */
export const checkRoundTrip: CheckFn = (s) => {
  const trainer = s.trainer as WasmTrainerApi;
  try {
    trainer.import_weights(s.weights as Float32Array);
  } catch (e) {
    return fail(s, "round-trip", `import_weights rejected the weights: ${errorText(e)}`, e);
  }
  const back = canonicalJson(JSON.parse(trainer.networkDefJson()));
  const file = canonicalJson(s.networkDef);
  if (back !== file) {
    fail(s, "round-trip", [
      "Trainer.networkDefJson() differs from network_def.json: a field was ignored or rewritten by this runtime",
      `file:  ${file}`,
      `wasm:  ${back}`,
    ]);
  }
  const reloaded = trainer.get_weights();
  const w = s.weights as Float32Array;
  if (reloaded.length !== w.length || reloaded.some((x, i) => x !== w[i])) {
    fail(s, "round-trip", "Trainer.get_weights() after import_weights is not bit-identical to weights.f32le");
  }
};
