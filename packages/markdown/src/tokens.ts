import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";

/**
 * The tokenizer of the token-reduction measure (protocol 10): `cl100k_base`, from `js-tiktoken` (pure JS, MIT; the
 * ranks ship inside the package, so it needs no network and no file download). It is NOT Claude's tokenizer: the
 * drift is measured against the API on 30 pages (`countTokensClaude`, `tokenDrift`).
 *
 * Text is encoded as ORDINARY text: a page that contains the literal `<|endoftext|>` is counted as the characters it
 * is, like tiktoken's `encode_ordinary` (the default call would throw on it).
 */
export const TOKENIZER_NAME = "cl100k_base";

let encoder: Tiktoken | undefined;

/** Number of cl100k_base tokens of `text`. Deterministic. */
export function countTokens(text: string): number {
  if (text === "") return 0;
  encoder ??= new Tiktoken(cl100k_base);
  return encoder.encode(text, [], []).length;
}

/** The token ids themselves (tests, debugging). */
export function encodeTokens(text: string): number[] {
  encoder ??= new Tiktoken(cl100k_base);
  return encoder.encode(text, [], []);
}
