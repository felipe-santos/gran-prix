import { canonicalJson } from "./canonical-json.js";
import { assertSha256, sha256Of, type Sha256 } from "./hash.js";

/** Input ids of a stage, by port name. A `many` port is an ordered list (order matters). */
export type StageInputIds = Readonly<Record<string, Sha256 | readonly Sha256[]>>;

export interface StageCacheKeyInput {
  /** Exact implementation id including version, e.g. `ts:label.readability@1.0.0`. */
  impl: string;
  /** Fully resolved params (after `${vars.*}` substitution). */
  params: unknown;
  /** Artifact id of every input, by port. */
  inputIds: StageInputIds;
  /** sha256 of the `.wasm` binary; only for stages that run it (train / evaluate). */
  wasmSha?: Sha256;
  /**
   * sha256 of the native tool binary a `runtime: "rust"` stage executes (e.g. `gp-train`). Hashed as
   * `env.tool_sha256` only when given, so keys of stages that do not use it do not change. (v1.1)
   */
  toolSha?: Sha256;
  /** Optional: stage kind. Redundant with `impl` today; kept in the hash when given. */
  kind?: string;
  /** Optional: Node major version, for stages whose numeric output may depend on it. */
  nodeMajor?: number;
}

/**
 * Cache key of a pipeline stage (A1 section 3.3):
 *
 *     sha256(canonical({ v, kind?, impl, params, inputs, env: { wasm_sha256?, node_major?, tool_sha256? } }))
 *
 * Deterministic and independent of: run id, wall clock, host, input port
 * declaration order, editor layout. Dependent on: the exact `impl`, the
 * resolved params, the ids (not paths) of every input, and, only when given,
 * the wasm binary and Node major.
 *
 * Absent optional parts are omitted from the hashed object (not hashed as
 * null), so adding a new optional dimension later does not invalidate the
 * existing keys of stages that do not use it.
 */
export function stageCacheKey(input: StageCacheKeyInput): Sha256 {
  const { impl, params, inputIds, wasmSha, toolSha, kind, nodeMajor } = input;
  if (typeof impl !== "string" || impl.length === 0) throw new TypeError("impl must be a non-empty string");
  for (const [port, v] of Object.entries(inputIds)) {
    if (Array.isArray(v)) v.forEach((id, i) => assertSha256(id, `inputIds.${port}[${i}]`));
    else assertSha256(v, `inputIds.${port}`);
  }
  if (wasmSha !== undefined) assertSha256(wasmSha, "wasmSha");
  if (toolSha !== undefined) assertSha256(toolSha, "toolSha");
  if (nodeMajor !== undefined && !Number.isInteger(nodeMajor)) throw new TypeError("nodeMajor must be an integer");
  const env: Record<string, unknown> = {};
  if (wasmSha !== undefined) env["wasm_sha256"] = wasmSha;
  if (nodeMajor !== undefined) env["node_major"] = nodeMajor;
  if (toolSha !== undefined) env["tool_sha256"] = toolSha;
  return sha256Of(
    canonicalJson({
      v: "gran-prix.stage-cache-key/1",
      kind,
      impl,
      params,
      inputs: inputIds,
      env,
    }),
  );
}

export interface LlmCacheKeyInput {
  provider: string;
  /** Exact model id. */
  model: string;
  promptSha256: Sha256;
  /** sha256 of the exact text sent, in order. */
  inputSha256: Sha256;
  params: { temperature: number; max_tokens: number };
  /** e.g. `keep_drop_lines@1`. */
  outputContract: string;
}

/** Cache key of one LLM labeling call (A1 section 3.3). No timestamp, run id or file name. */
export function llmCacheKey(input: LlmCacheKeyInput): Sha256 {
  assertSha256(input.promptSha256, "promptSha256");
  assertSha256(input.inputSha256, "inputSha256");
  return sha256Of(
    canonicalJson({
      v: "gran-prix.llm-cache-key/1",
      provider: input.provider,
      model: input.model,
      prompt_sha256: input.promptSha256,
      input_sha256: input.inputSha256,
      params: input.params,
      output_contract: input.outputContract,
    }),
  );
}
