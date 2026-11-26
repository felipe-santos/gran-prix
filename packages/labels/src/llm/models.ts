import type { PriceTable } from "./types.js";

/**
 * What each current model accepts, so that a bad combination fails loudly BEFORE any call (and before the ledger is
 * touched) instead of as a paid-for 400. Facts of the API as of 2026-11 (official docs); the labeler never guesses:
 * a model that is not in the table is accepted only with the plain request (`thinking: "model-default"`, no `effort`).
 *
 *  - Sampling: `claude-sonnet-5-5` rejects a non-default `temperature` (so `0` is a 400); `claude-opus-5-5` rejects the
 *    parameter entirely (400); `claude-haiku-5-5` rejects non-default sampling values (claude-api reference, 2026-11).
 *    With these models the labeler runs with `send_temperature: false`; reproducibility comes from the response cache
 *    (DESVIOS #24), not from sampling.
 *  - Thinking: omitting `thinking` runs the model's default reasoning (Opus 5.5: always on and CANNOT be disabled;
 *    Sonnet 5.5: adaptive, effort `high`; Haiku 5.5: adaptive, effort `medium`). To turn it off: Sonnet 5.5 takes
 *    `{type: "between_tools"}` (nothing else in the object, accepted only at effort `high` or lower); Haiku 5.5 takes
 *    `{type: "disabled"}` (at effort `high` or lower; from the claude-api reference, not from the lane brief).
 *  - Effort: `output_config.effort`, here `low | medium | high` (the API also has `xhigh`/`max`; they are left out on
 *    purpose: the labeler is a classifier and the reserve of the ledger assumes bounded thinking).
 *  - Thinking tokens are billed as OUTPUT and count against `max_tokens`.
 */

export type ThinkingMode = "model-default" | "off";
export type Effort = "low" | "medium" | "high";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high"];
export const THINKING_MODES: readonly ThinkingMode[] = ["model-default", "off"];

export interface ModelRules {
  id: string;
  /** `rejected`: any `temperature` is a 400 (also 0). */
  temperature: "rejected";
  /** Body of `thinking` that turns the reasoning off, or null when the model cannot be run without it. */
  thinking_off: { type: "between_tools" | "disabled" } | null;
  default_effort: Effort;
  /** USD per million tokens (2026-11, prompt <= 100k tokens). */
  prices: Required<PriceTable>;
}

/** Reference prices of the current models, per million tokens, from the official docs of 2026-11. */
export const MODEL_RULES: Readonly<Record<string, ModelRules>> = {
  "claude-sonnet-5-5": {
    id: "claude-sonnet-5-5",
    temperature: "rejected",
    thinking_off: { type: "between_tools" },
    default_effort: "high",
    prices: { input_usd_per_mtok: 2, output_usd_per_mtok: 10, cache_write_usd_per_mtok: 2.5, cache_read_usd_per_mtok: 0.1 },
  },
  "claude-opus-5-5": {
    id: "claude-opus-5-5",
    temperature: "rejected",
    thinking_off: null,
    default_effort: "medium",
    prices: { input_usd_per_mtok: 4, output_usd_per_mtok: 20, cache_write_usd_per_mtok: 5, cache_read_usd_per_mtok: 0.2 },
  },
  "claude-haiku-5-5": {
    id: "claude-haiku-5-5",
    temperature: "rejected",
    thinking_off: { type: "disabled" },
    default_effort: "medium",
    // Cache read is not in the lane table; 0.1x of the input price is the documented ratio (claude-api reference).
    prices: { input_usd_per_mtok: 0.1, output_usd_per_mtok: 0.5, cache_write_usd_per_mtok: 0.125, cache_read_usd_per_mtok: 0.01 },
  },
};

/** The table row of a model id (a trailing `-YYYYMMDD` snapshot suffix is ignored), or undefined. */
export function modelRules(model: string): ModelRules | undefined {
  return MODEL_RULES[model.replace(/-\d{8}$/, "")];
}

export class ModelParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelParamsError";
  }
}

export interface ModelCallParams {
  model: string;
  /** True when the request will carry a `temperature`. */
  temperature_sent: boolean;
  thinking?: ThinkingMode | undefined;
  effort?: Effort | undefined;
}

/** Throws `ModelParamsError` (clear message, naming the fix) when the API would answer 400 for this combination. */
export function validateModelParams(p: ModelCallParams): void {
  const thinking = p.thinking ?? "model-default";
  if (!THINKING_MODES.includes(thinking)) throw new ModelParamsError(`thinking must be "model-default" or "off" (got ${JSON.stringify(thinking)})`);
  if (p.effort !== undefined && !EFFORTS.includes(p.effort)) throw new ModelParamsError(`effort must be one of ${EFFORTS.join(", ")} (got ${JSON.stringify(p.effort)})`);
  const rules = modelRules(p.model);
  if (!rules) {
    if (thinking === "off" || p.effort !== undefined) {
      throw new ModelParamsError(
        `model "${p.model}" is not in the validated table (${Object.keys(MODEL_RULES).join(", ")}): thinking "off" and effort cannot be checked for it, so only thinking "model-default" without effort is allowed`,
      );
    }
    return;
  }
  if (p.temperature_sent) {
    throw new ModelParamsError(
      `${rules.id} rejects the temperature parameter with a 400 (sampling parameters are fixed on this model): set send_temperature to false. Reproducibility comes from the response cache.`,
    );
  }
  if (thinking === "off" && rules.thinking_off === null) {
    throw new ModelParamsError(`${rules.id} always thinks and rejects thinking {type: "disabled"} with a 400: use thinking "model-default" and lower effort instead`);
  }
}

/** The `thinking` field of the request body for a mode, or undefined (= leave the field out). */
export function thinkingField(model: string, thinking: ThinkingMode | undefined): { type: string } | undefined {
  if (thinking !== "off") return undefined;
  const off = modelRules(model)?.thinking_off;
  if (!off) throw new ModelParamsError(`thinking "off" is not available on ${model}`);
  return { type: off.type };
}
