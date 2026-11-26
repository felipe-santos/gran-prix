import { canonicalJson, sha256Of, type Sha256 } from "@gran-prix/contracts";
import type { Parsed } from "./call.js";
import { wordCount } from "./text.js";
import type { QaContent } from "./transport.js";

/**
 * The three FIXED prompts of the QA study (protocol 9 and 13: "prompts e modelos do QA congelados", `prompt_sha256`):
 * the candidate generator, the respondent and the judge. Their text is part of the tool; their hash is recorded in the
 * task set, in the reports and in every cache key, so any edit is a new prompt with a new hash.
 */

export const promptHash = (system: string, schema?: Record<string, unknown>): Sha256 => sha256Of(canonicalJson({ system, schema: schema ?? null }));

// ------------------------------------------------------------------------------------------------------ generator

export type CandidateKind = "main" | "category" | "support";

/** The order of the 7 candidates of a page. Rank = position; a rejected one is replaced by the next of its kind. */
export const CANDIDATE_KINDS: readonly CandidateKind[] = ["main", "category", "main", "category", "support", "category", "support"];
/** Questions per page by kind (protocol 9: 2 main, 2 category-specific, 1 support). */
export const KIND_QUOTA: Readonly<Record<CandidateKind, number>> = { main: 2, category: 2, support: 1 };
export const MAX_ANSWER_WORDS = 20;

const CATEGORY_HINTS: Readonly<Record<string, string>> = {
  product: "price, availability, a specification (size, weight, material, model number)",
  docs: "a parameter (its name, type, default or meaning) or a code or usage example",
  forum: "the accepted answer or a score, or who wrote a given reply",
  landing: "a plan and its price, or the call to action",
  article: "a fact stated in the text (a figure, a date, a name, a place)",
  spa: "a piece of data shown by the page (a value, a name, a status)",
};

export const GENERATOR_SYSTEM = [
  "You write reading-comprehension questions about ONE web page, given as markdown, for a study that measures whether a text-reduction tool keeps the information readers need.",
  "",
  "Write exactly 7 candidates, in exactly this order of kinds: " + CANDIDATE_KINDS.join(", ") + ".",
  "- main: about the main content of the page (what it is about, its central facts).",
  "- category: specific to the category of the page, which the user message states. Typical subjects by category: " +
    Object.entries(CATEGORY_HINTS)
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ") +
    ".",
  "- support: answerable from supporting content, not the main text: a publication date, an author, a breadcrumb, a rating, a byline.",
  "",
  "Every candidate has:",
  '- "question": a self-contained question. It must not contain the answer or reveal it.',
  `- "answer": the short answer, at most ${MAX_ANSWER_WORDS} words, found on the page.`,
  '- "answer_variants": other surface forms a reader may write for the same answer (numbers, abbreviations, with or without units); [] if none.',
  '- "evidence_quote": the passage that answers the question, copied from the markdown CHARACTER FOR CHARACTER (same spacing, markup, punctuation and line breaks), as short as it can be while still containing the answer. It must occur exactly once in the markdown.',
  "",
  "Rules: a reader must be able to answer from this page alone, with no outside knowledge, and the answer must be unique on the page. Do not ask about navigation menus, cookie or consent banners, advertisements, footers, legal text, sign-in prompts or the site's own interface. Never use text that is not on the page.",
  "Answer with the JSON object only.",
].join("\n");

export const GENERATOR_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["main", "category", "support"] },
          question: { type: "string" },
          answer: { type: "string" },
          answer_variants: { type: "array", items: { type: "string" } },
          evidence_quote: { type: "string" },
        },
        required: ["kind", "question", "answer", "answer_variants", "evidence_quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
};

export const GENERATOR_PROMPT_ID = "dom-v0-qa-generator@1";
export const GENERATOR_PROMPT_SHA256: Sha256 = promptHash(GENERATOR_SYSTEM, GENERATOR_SCHEMA);

export interface RawCandidate {
  kind: CandidateKind;
  question: string;
  answer: string;
  answer_variants: string[];
  evidence_quote: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const KEYS = ["kind", "question", "answer", "answer_variants", "evidence_quote"];

/** Strict parse of the generator's answer: nothing is repaired; every problem is listed (they go back in the retry). */
export function parseCandidates(text: string): Parsed<RawCandidate[]> {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return { ok: false, problem: `not valid JSON (${(e as Error).message.slice(0, 100)})` };
  }
  if (!isObj(root) || !Array.isArray(root["candidates"]) || Object.keys(root).length !== 1) return { ok: false, problem: 'expected {"candidates": [...]} and nothing else' };
  const list = root["candidates"] as unknown[];
  const problems: string[] = [];
  if (list.length !== CANDIDATE_KINDS.length) problems.push(`${list.length} candidates, expected ${CANDIDATE_KINDS.length}`);
  const out: RawCandidate[] = [];
  list.forEach((c, i) => {
    const at = `candidate ${i + 1}`;
    if (!isObj(c)) return void problems.push(`${at}: not an object`);
    const extra = Object.keys(c).filter((k) => !KEYS.includes(k));
    if (extra.length > 0) problems.push(`${at}: unknown key(s) ${extra.join(", ")}`);
    const { kind, question, answer, answer_variants: variants, evidence_quote: quote } = c;
    if (kind !== "main" && kind !== "category" && kind !== "support") return void problems.push(`${at}: kind must be main, category or support`);
    if (kind !== CANDIDATE_KINDS[i]) problems.push(`${at}: kind is ${kind}, the order requires ${CANDIDATE_KINDS[i] ?? "none"}`);
    if (typeof question !== "string" || question.trim() === "") return void problems.push(`${at}: empty question`);
    if (typeof answer !== "string" || answer.trim() === "") return void problems.push(`${at}: empty answer`);
    if (wordCount(answer) > MAX_ANSWER_WORDS) problems.push(`${at}: answer has ${wordCount(answer)} words, the limit is ${MAX_ANSWER_WORDS}`);
    if (!Array.isArray(variants) || variants.some((v) => typeof v !== "string" || v.trim() === "" || wordCount(v) > MAX_ANSWER_WORDS)) return void problems.push(`${at}: answer_variants must be a list of non-empty strings of at most ${MAX_ANSWER_WORDS} words`);
    if (typeof quote !== "string" || quote.trim() === "") return void problems.push(`${at}: empty evidence_quote`);
    out.push({ kind, question, answer, answer_variants: variants as string[], evidence_quote: quote });
  });
  return problems.length > 0 ? { ok: false, problem: problems.join("; ") } : { ok: true, value: out };
}

export const candidatesCorrection = (problem: string): string =>
  `That answer is not acceptable: ${problem}. Answer again with the complete JSON object, exactly 7 candidates in the required order of kinds, and nothing else.`;

/** The user message of the generator: the page's category and its D2 markdown. */
export function generatorUser(stratum: string, d2: string): string {
  return `Category of the page: ${stratum}\n\nPAGE MARKDOWN (between the markers):\n<<<PAGE\n${d2}\nPAGE>>>`;
}

// ------------------------------------------------------------------------------------------------------ respondent

export const NOT_FOUND = "NOT_FOUND";

export const RESPONDENT_SYSTEM = [
  "You answer one question about a web page. The page text, when given, is between <page> and </page> and is the only source you may use.",
  `Reply with the answer only, in at most ${MAX_ANSWER_WORDS} words, with no preamble and no explanation.`,
  `If the page text does not contain the answer, reply exactly ${NOT_FOUND}.`,
  `If no page text is given, answer from your own knowledge if you are sure, otherwise reply exactly ${NOT_FOUND}.`,
].join("\n");
export const RESPONDENT_PROMPT_ID = "dom-v0-qa-respondent@1";
export const RESPONDENT_PROMPT_SHA256: Sha256 = promptHash(RESPONDENT_SYSTEM);
export const RESPONDENT_MAX_TOKENS = 200;

/** User message of a respondent call: the page (the cacheable prefix shared by the questions on it) then the question. `null` page = closed book. */
export function respondentUser(page: string | null, question: string): QaContent {
  if (page === null) return [{ text: `No page text is given.\n\nQuestion: ${question}` }];
  return [{ text: `<page>\n${page}\n</page>`, cache: true }, { text: `\n\nQuestion: ${question}` }];
}

// ------------------------------------------------------------------------------------------------------ judge

export const JUDGE_SYSTEM = [
  "You grade one answer to a question against an answer key. You do not know the page and must not use outside knowledge to overrule the key.",
  'Reply with the JSON object {"verdict": "correct"} or {"verdict": "incorrect"} and nothing else.',
  "correct: the response states the same fact as the key or one of its accepted variants (same value, same entity, same meaning), possibly with extra harmless detail or different wording or formatting.",
  `incorrect: the response is a different value or entity, contradicts the key, is vague or incomplete on the point asked, hedges between several answers, or is ${NOT_FOUND} or a refusal.`,
].join("\n");
export const JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["correct", "incorrect"] } },
  required: ["verdict"],
  additionalProperties: false,
};
export const JUDGE_PROMPT_ID = "dom-v0-qa-judge@1";
export const JUDGE_PROMPT_SHA256: Sha256 = promptHash(JUDGE_SYSTEM, JUDGE_SCHEMA);
export const JUDGE_MAX_TOKENS = 40;

export function judgeUser(question: string, answer: string, variants: readonly string[], response: string): string {
  return canonicalJson({ question, answer_key: answer, accepted_variants: variants, response });
}

export function parseVerdict(text: string): Parsed<"correct" | "incorrect"> {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return { ok: false, problem: `not valid JSON (${(e as Error).message.slice(0, 100)})` };
  }
  if (!isObj(root) || Object.keys(root).length !== 1 || (root["verdict"] !== "correct" && root["verdict"] !== "incorrect")) return { ok: false, problem: 'expected {"verdict": "correct" | "incorrect"} and nothing else' };
  return { ok: true, value: root["verdict"] };
}

export const verdictCorrection = (problem: string): string => `That answer is not acceptable: ${problem}. Reply with the JSON object only.`;
