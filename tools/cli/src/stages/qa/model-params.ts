/**
 * Request parameters of the QA calls, validated PER MODEL and recorded (protocol 9: "temperatura 0, max_tokens 200,
 * sem ferramentas"; 13: models and prompts frozen).
 *
 * The current models reject `temperature`, so three knobs exist, as in the labeler: `send_temperature` (false by
 * default here), `thinking` (`off`, or `adaptive` where the model has it) and `effort`. What each model accepts is a
 * table of CAPABILITIES. Model ids never appear in code: a capability row is found by FAMILY (haiku, sonnet, opus,
 * matched in the id the caller gives) or given by the caller for an exact id (`capabilities` param). A model of
 * unknown family with no declared capabilities is refused BEFORE any call, so nothing is guessed.
 *
 * ASSUMPTION [NV]: the rows below and the wire format of `thinking` and `effort` are what the brief describes
 * ("off = between_tools where it exists"), not something this tool could check against the API (no paid call is
 * allowed). The first real call (a 400 is free) is the check; the owner can override any row per model id.
 */

export type ThinkingMode = "off" | "adaptive";
export type ThinkingOffWire = "omit" | "disabled" | "between_tools";

export interface ModelCaps {
  /** The API rejects `temperature` for this model: `send_temperature: true` is an error. */
  rejects_temperature: boolean;
  /** What `thinking: "off"` becomes on the wire: nothing, `{type:"disabled"}`, or `{type:"between_tools"}`. */
  thinking_off_wire: ThinkingOffWire;
  /** Thinking modes the model accepts. */
  thinking_modes: ThinkingMode[];
  /** Values of `effort` the model accepts; empty = the parameter does not exist for it. */
  efforts: string[];
}

const SMALL: ModelCaps = { rejects_temperature: true, thinking_off_wire: "omit", thinking_modes: ["off"], efforts: [] };
const BIG: ModelCaps = { rejects_temperature: true, thinking_off_wire: "between_tools", thinking_modes: ["off", "adaptive"], efforts: ["low", "medium", "high"] };

/** Capability rows by family; matched against the model id the caller supplies. */
export const FAMILY_CAPS: ReadonlyArray<{ family: string; pattern: RegExp; caps: ModelCaps }> = [
  { family: "haiku", pattern: /haiku/i, caps: SMALL },
  { family: "sonnet", pattern: /sonnet/i, caps: BIG },
  { family: "opus", pattern: /opus/i, caps: BIG },
];

export interface RequestParamsIn {
  send_temperature?: boolean;
  thinking?: ThinkingMode;
  effort?: string;
}

/** The wire fields a request carries, and what is recorded in the reports. */
export interface ResolvedParams {
  send_temperature: boolean;
  thinking: ThinkingMode;
  effort: string | null;
  /** `thinking` as sent; null = nothing sent. */
  thinking_wire: { type: string } | null;
  /** Capability row used and where it came from. */
  caps: ModelCaps;
  caps_source: string;
}

export const PARAMS_PROPERTIES = {
  send_temperature: { type: "boolean", description: "Send temperature 0 (default false: current models reject it). true is refused for a model whose capabilities say it rejects the parameter." },
  thinking: { enum: ["off", "adaptive"], description: 'Thinking mode (default "off": nothing sent, or between_tools where the model has it).' },
  effort: { type: "string", minLength: 1, description: "Effort level, only for models that have it; validated against the model's capabilities." },
} as const;

/** The `capabilities` param: exact model id -> row. */
export const CAPABILITIES_SCHEMA = {
  type: "object",
  description: "Capability rows by exact model id; they win over the family table. Use for a model of a family the tool does not know.",
  additionalProperties: {
    type: "object",
    required: ["rejects_temperature", "thinking_off_wire", "thinking_modes", "efforts"],
    additionalProperties: false,
    properties: {
      rejects_temperature: { type: "boolean" },
      thinking_off_wire: { enum: ["omit", "disabled", "between_tools"] },
      thinking_modes: { type: "array", items: { enum: ["off", "adaptive"] } },
      efforts: { type: "array", items: { type: "string" } },
    },
  },
} as const;

export function capsFor(model: string, overrides?: Readonly<Record<string, ModelCaps>>): { caps: ModelCaps; source: string } {
  const own = overrides?.[model];
  if (own !== undefined) return { caps: own, source: `params.capabilities["${model}"]` };
  const fam = FAMILY_CAPS.find((f) => f.pattern.test(model));
  if (fam === undefined) {
    throw new Error(`model "${model}": unknown model family and no params.capabilities entry for it. Declare what it accepts (rejects_temperature, thinking_off_wire, thinking_modes, efforts); nothing is guessed`);
  }
  return { caps: fam.caps, source: `family table: ${fam.family}` };
}

/** Validates the knobs for a model; throws a readable error, never calls anything. */
export function resolveParams(model: string, input: RequestParamsIn = {}, overrides?: Readonly<Record<string, ModelCaps>>): ResolvedParams {
  const { caps, source } = capsFor(model, overrides);
  const send = input.send_temperature === true;
  if (send && caps.rejects_temperature) {
    throw new Error(`model "${model}" rejects temperature (${source}): leave send_temperature false`);
  }
  const thinking: ThinkingMode = input.thinking ?? "off";
  if (!caps.thinking_modes.includes(thinking)) {
    throw new Error(`model "${model}" does not accept thinking "${thinking}" (${source}; accepts: ${caps.thinking_modes.join(", ") || "none"})`);
  }
  const effort = input.effort ?? null;
  if (effort !== null && !caps.efforts.includes(effort)) {
    throw new Error(`model "${model}" does not accept effort "${effort}" (${source}; accepts: ${caps.efforts.join(", ") || "no effort parameter"})`);
  }
  let wire: { type: string } | null = null;
  if (thinking === "adaptive") wire = { type: "adaptive" };
  else if (caps.thinking_off_wire === "disabled") wire = { type: "disabled" };
  else if (caps.thinking_off_wire === "between_tools") wire = { type: "between_tools" };
  return { send_temperature: send, thinking, effort, thinking_wire: wire, caps, caps_source: source };
}

/** What goes into reports and cache keys (no capability row: the row is what validated, these are the choices). */
export function recordedParams(p: ResolvedParams): { send_temperature: boolean; thinking: ThinkingMode; thinking_wire: string; effort: string | null; caps_source: string } {
  return { send_temperature: p.send_temperature, thinking: p.thinking, thinking_wire: p.thinking_wire?.type ?? "omitted", effort: p.effort, caps_source: p.caps_source };
}

/** Suffix of the cache-key output contract: every knob that changes the request changes the key. */
export function paramsKeyPart(p: ResolvedParams): string {
  return `temp=${p.send_temperature ? 0 : "off"}|think=${p.thinking_wire?.type ?? "omit"}|effort=${p.effort ?? "-"}`;
}
