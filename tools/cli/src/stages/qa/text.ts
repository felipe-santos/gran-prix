/**
 * Text normalization of the QA tool (protocol section 9): answer matching and evidence retention. Pure, no I/O.
 *
 * Two normalizations, on purpose:
 *  - ANSWER matching (`normalizeAnswer`): case, diacritics, quotes, dashes and separators are folded; thousands
 *    separators inside numbers are dropped ("1,299" = "1299"); everything that is not a letter or a digit becomes
 *    one space. Whole-word containment, never a raw substring ("5" is not in "15").
 *  - RETENTION (`retentionTokens`): the same fold applied to markdown, then the maximal runs of letters and digits.
 *    Markdown syntax (`**`, `[](...)`, bullets) therefore never decides whether evidence survived.
 */

const DASHES = /[‐-―−]/g;
const QUOTES = /[‘’‚‛′]/g;
const DQUOTES = /[“”„‟″]/g;

/** NFKC, lower case, no diacritics, straight quotes and hyphen-minus. */
export function foldText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(DASHES, "-")
    .replace(QUOTES, "'")
    .replace(DQUOTES, '"')
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/** Folded text with every non-alphanumeric run turned into one space, thousands separators of numbers dropped. */
export function normalizeAnswer(s: string): string {
  return foldText(s)
    .replace(/(\d)[,  ](?=\d{3}(?!\d))/g, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Whole-word containment of normalized text: " b " occurs in " a ". Both arguments are already normalized. */
export function containsPhrase(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/** Words of a raw answer as the contract counts them (`answer.trim().split(/\s+/)`, at most 20). */
export const wordCount = (s: string): number => (s.trim() === "" ? 0 : s.trim().split(/\s+/).length);

export type MatchKind = "exact" | "contains";

/**
 * Deterministic match of a response against the key (protocol 9, "casamento normalizado exato/contencao"):
 * `exact` when the whole normalized response equals the answer or a variant, `contains` when one of them occurs in it
 * as whole words, `null` otherwise.
 */
export function matchAnswer(response: string, answer: string, variants: readonly string[]): MatchKind | null {
  const r = normalizeAnswer(response);
  if (r === "") return null;
  const keys = [answer, ...variants].map(normalizeAnswer).filter((k) => k !== "");
  if (keys.some((k) => k === r)) return "exact";
  if (keys.some((k) => containsPhrase(r, k))) return "contains";
  return null;
}

/** A "fact" is an answer short enough to be decided by string matching alone (default at most 5 normalized words). */
export function isFact(answer: string, maxWords: number): boolean {
  const n = normalizeAnswer(answer);
  return n !== "" && n.split(" ").length <= maxWords;
}

/** Letter/digit tokens of a text for the retention measure. */
export function retentionTokens(markdown: string): string[] {
  return foldText(markdown).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** `needle` occurs in `hay` as a contiguous run of tokens (principal retention, M6). */
export function containsRun(hay: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false;
  if (needle.length > hay.length) return false;
  const first = needle[0] as string;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (hay[i] !== first) continue;
    let k = 1;
    while (k < needle.length && hay[i + k] === needle[k]) k++;
    if (k === needle.length) return true;
  }
  return false;
}

/** Fraction of the needle's tokens present in the output, with multiplicity (secondary retention, M6). */
export function tokenFraction(hay: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0) return 0;
  const have = new Map<string, number>();
  for (const t of hay) have.set(t, (have.get(t) ?? 0) + 1);
  let present = 0;
  for (const t of needle) {
    const c = have.get(t) ?? 0;
    if (c > 0) {
      present++;
      have.set(t, c - 1);
    }
  }
  return present / needle.length;
}

/** Number of (possibly overlapping) occurrences of `needle` in `hay`. */
export function countOccurrences(hay: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}
