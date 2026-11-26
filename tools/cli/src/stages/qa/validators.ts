import type { NodeLabels } from "@gran-prix/contracts";
import { unitsTouching, type UnitSpan } from "./locate.js";
import type { CandidateKind, RawCandidate } from "./prompts.js";
import { containsPhrase, countOccurrences, normalizeAnswer } from "./text.js";

/**
 * The automatic validators of a candidate (protocol 9, "Validadores automaticos"). Pure functions of the D2 text, the
 * unit spans and the gold labels of the page. A rejected candidate keeps every reason that applies (the rejection
 * rate and its causes are reported); the human sees only the ones that pass.
 *
 *  1. the quote occurs EXACTLY ONCE in the D2 text (0: `quote_not_found`; 2 or more: `quote_not_unique`);
 *  2. the elements the quote touches have a gold class compatible with the kind, and none is `noise`:
 *       main     -> every touched unit is `main`
 *       support  -> every touched unit is `support`
 *       category -> every touched unit is `main` or `support`
 *     a touched unit with no gold label cannot be judged and rejects (`unit_without_gold`);
 *  3. the question does not contain the answer (whole-word, normalized) nor any variant;
 * plus hygiene: the quote is neither a stub nor a page (`quote_too_short`, `quote_too_long`), it touches at least one
 * element (`no_unit`: a quote made only of markup, e.g. a link target) and the question is not a repeat of an earlier
 * candidate of the page (`duplicate_question`). `answer_not_in_quote` is ADVISORY: the human is told, nothing is rejected.
 */

export type GoldClass = "main" | "support" | "noise";

export const REJECT_REASONS = [
  "quote_not_found",
  "quote_not_unique",
  "quote_too_short",
  "quote_too_long",
  "no_unit",
  "unit_without_gold",
  "evidence_in_noise",
  "kind_class_mismatch",
  "question_contains_answer",
  "duplicate_question",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** Gold class per unit of a 3-class NodeLabels document. */
export function goldClassMap(doc: NodeLabels): Map<number, GoldClass> {
  const classes: readonly string[] = doc.label_space.classes;
  for (const c of ["main", "support", "noise"]) {
    if (!classes.includes(c)) throw new Error(`gold labels of ${doc.snapshot_id} are not 3-class (main/support/noise): label space ${JSON.stringify(classes)}`);
  }
  const out = new Map<number, GoldClass>();
  for (const it of doc.items) out.set(it.unit_id, classes[it.y] as GoldClass);
  return out;
}

export interface ValidationContext {
  d2: string;
  spans: readonly UnitSpan[];
  gold: ReadonlyMap<number, GoldClass>;
  /** Normalized questions of the candidates already seen on the page. */
  seenQuestions: Set<string>;
  minQuoteChars: number;
  maxQuoteChars: number;
}

export interface Evidence {
  unit_ids: number[];
  /** Gold class of each unit in `unit_ids`. */
  unit_classes: GoldClass[];
  /** `main` when any unit is main, else `support`. */
  class: "main" | "support";
  /** Offset of the quote in the D2 text. */
  offset: number;
}

export interface CandidateCheck {
  status: "pass" | "reject";
  reasons: RejectReason[];
  advisory: string[];
  evidence?: Evidence;
}

const compatible = (kind: CandidateKind, c: GoldClass): boolean => (kind === "main" ? c === "main" : kind === "support" ? c === "support" : c !== "noise");

export function checkCandidate(c: RawCandidate, ctx: ValidationContext): CandidateCheck {
  const reasons: RejectReason[] = [];
  const advisory: string[] = [];
  let evidence: Evidence | undefined;

  const n = countOccurrences(ctx.d2, c.evidence_quote);
  if (n === 0) reasons.push("quote_not_found");
  else if (n > 1) reasons.push("quote_not_unique");
  if (c.evidence_quote.trim().length < ctx.minQuoteChars) reasons.push("quote_too_short");
  if (c.evidence_quote.length > ctx.maxQuoteChars) reasons.push("quote_too_long");

  if (n === 1) {
    const offset = ctx.d2.indexOf(c.evidence_quote);
    const units = unitsTouching(ctx.spans, offset, offset + c.evidence_quote.length);
    if (units.length === 0) reasons.push("no_unit");
    else {
      const classes = units.map((u) => ctx.gold.get(u));
      if (classes.some((k) => k === undefined)) reasons.push("unit_without_gold");
      else {
        const known = classes as GoldClass[];
        if (known.includes("noise")) reasons.push("evidence_in_noise");
        else if (!known.every((k) => compatible(c.kind, k))) reasons.push("kind_class_mismatch");
        else evidence = { unit_ids: units, unit_classes: known, class: known.includes("main") ? "main" : "support", offset };
      }
    }
  }

  const q = normalizeAnswer(c.question);
  const keys = [c.answer, ...c.answer_variants].map(normalizeAnswer).filter((k) => k !== "");
  if (keys.some((k) => containsPhrase(q, k))) reasons.push("question_contains_answer");
  if (ctx.seenQuestions.has(q)) reasons.push("duplicate_question");
  ctx.seenQuestions.add(q);

  const quote = normalizeAnswer(c.evidence_quote);
  if (!keys.some((k) => containsPhrase(quote, k))) advisory.push("answer_not_in_quote");

  if (reasons.length > 0) return { status: "reject", reasons, advisory };
  return { status: "pass", reasons, advisory, ...(evidence ? { evidence } : {}) };
}
