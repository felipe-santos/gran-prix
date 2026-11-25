import type { BlockAnswer, LlmClass } from "./types.js";

/**
 * Strict validation of the model's answer (protocol 5.3: `{"labels":[{"id":"n123","c":"M|S|N","u":false}]}`).
 * Nothing is repaired or guessed: code fences, prose around the JSON, extra keys, a bad class, a repeated id,
 * an id that was not asked and a missing id are all problems. The caller decides what a problem costs
 * (one bounded retry with `correctionMessage`, then the page fails).
 */

export const ANSWER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    labels: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          c: { type: "string", enum: ["M", "S", "N"] },
          u: { type: "boolean" },
          m: { type: "boolean" },
        },
        required: ["id", "c", "u", "m"],
        additionalProperties: false,
      },
    },
  },
  required: ["labels"],
  additionalProperties: false,
};

export interface Validation {
  /** Well-formed answers for ids that were asked, first occurrence wins. */
  answers: BlockAnswer[];
  /** Why the text is not the expected JSON, or null. */
  malformed: string | null;
  /** Ids in the answer that were not asked. */
  unknown: string[];
  /** Ids answered more than once. */
  duplicates: string[];
  /** Asked ids with no answer. */
  missing: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function isClean(v: Validation): boolean {
  return v.malformed === null && v.unknown.length === 0 && v.duplicates.length === 0 && v.missing.length === 0;
}

export function validateAnswer(text: string, askedIds: readonly string[]): Validation {
  const asked = new Set(askedIds);
  const out: Validation = { answers: [], malformed: null, unknown: [], duplicates: [], missing: [] };
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    out.malformed = `not valid JSON (${(e as Error).message.slice(0, 120)})`;
    out.missing = [...askedIds];
    return out;
  }
  if (!isObj(root) || Object.keys(root).length !== 1 || !Array.isArray(root["labels"])) {
    out.malformed = 'expected exactly {"labels":[...]}';
    out.missing = [...askedIds];
    return out;
  }
  const seen = new Set<string>();
  for (const [i, e] of (root["labels"] as unknown[]).entries()) {
    const keys = isObj(e) ? Object.keys(e) : [];
    const ok =
      isObj(e) &&
      typeof e["id"] === "string" &&
      (e["c"] === "M" || e["c"] === "S" || e["c"] === "N") &&
      typeof e["u"] === "boolean" &&
      (e["m"] === undefined || typeof e["m"] === "boolean") &&
      keys.every((k) => k === "id" || k === "c" || k === "u" || k === "m");
    if (!ok) {
      out.malformed ??= `labels[${i}] is not {"id":string,"c":"M"|"S"|"N","u":boolean,"m":boolean}`;
      continue;
    }
    const id = e["id"] as string;
    if (!asked.has(id)) {
      out.unknown.push(id);
      continue;
    }
    if (seen.has(id)) {
      out.duplicates.push(id);
      continue;
    }
    seen.add(id);
    out.answers.push({ id, c: e["c"] as LlmClass, u: e["u"] as boolean, m: e["m"] === true });
  }
  out.missing = askedIds.filter((id) => !seen.has(id));
  return out;
}

const list = (ids: readonly string[]): string => (ids.length > 12 ? `${ids.slice(0, 12).join(", ")} and ${ids.length - 12} more` : ids.join(", "));

/** The one correction message of the bounded retry: says exactly what was wrong, asks for the whole answer again. */
export function correctionMessage(v: Validation): string {
  const problems: string[] = [];
  if (v.malformed) problems.push(`the answer was ${v.malformed}`);
  if (v.unknown.length) problems.push(`these ids were not asked: ${list(v.unknown)}`);
  if (v.duplicates.length) problems.push(`these ids appear more than once: ${list(v.duplicates)}`);
  if (v.missing.length) problems.push(`these ids have no answer: ${list(v.missing)}`);
  return `Your answer was rejected: ${problems.join("; ")}. Answer again with the COMPLETE JSON object {"labels":[...]}: exactly one entry per id under BLOCKS, only those ids, nothing else.`;
}
