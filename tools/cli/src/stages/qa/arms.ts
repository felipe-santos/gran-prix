import { sha256Of, type Sha256 } from "@gran-prix/contracts";
import { containsRun, retentionTokens, tokenFraction } from "./text.js";

/**
 * The arms of the QA study (protocol 9) and where their text comes from. Every arm that shows a page shows the output
 * of the SAME converter (`@gran-prix/markdown`, written by `ts:measure.tokens` into its `markdown` bundle):
 *
 *   full_page          d2/<hex12>.md                  the whole page (D2)
 *   pruned_model       out/<system>/<hex12>.md        the model at tau* (frozen model on test pages, OOF on dev pages)
 *   pruned_router      out/<system>/<hex12>.md        the heuristic router (B4)
 *   oracle             out/<system>/<hex12>.md        the gold labels through the same converter
 *   closed_book        (no page)                      measures memorization
 *   pruned_readability / pruned_trafilatura / pruned_defuddle   R1 only, the baselines
 *
 * A page a system has no output for is an EMPTY output (the convention of `measure.tokens`: no document, no credit).
 */

export const FULL_PAGE = "full_page";
export const PRUNED_MODEL = "pruned_model";
export const PRUNED_ROUTER = "pruned_router";
export const ORACLE = "oracle";
export const CLOSED_BOOK = "closed_book";
export const PRUNED_READABILITY = "pruned_readability";
export const PRUNED_TRAFILATURA = "pruned_trafilatura";
export const PRUNED_DEFUDDLE = "pruned_defuddle";

/** Order of asking = priority: the cut order of 5.6 removes from the tail, the baselines first. */
export const R1_ARMS: readonly string[] = [FULL_PAGE, PRUNED_MODEL, ORACLE, CLOSED_BOOK, PRUNED_ROUTER, PRUNED_READABILITY, PRUNED_TRAFILATURA, PRUNED_DEFUDDLE];
export const R2_ARMS: readonly string[] = [FULL_PAGE, PRUNED_MODEL, ORACLE, CLOSED_BOOK, PRUNED_ROUTER];
export const BASELINE_ARMS: readonly string[] = [PRUNED_READABILITY, PRUNED_TRAFILATURA, PRUNED_DEFUDDLE];

/** Default `markdown` system id of each pruned arm; `params.arm_systems` overrides. */
export const DEFAULT_ARM_SYSTEMS: Readonly<Record<string, string>> = {
  [PRUNED_MODEL]: "model",
  [PRUNED_ROUTER]: "router",
  [ORACLE]: "oracle",
  [PRUNED_READABILITY]: "readability",
  [PRUNED_TRAFILATURA]: "trafilatura",
  [PRUNED_DEFUDDLE]: "defuddle",
};

export const isKnownArm = (arm: string): boolean => arm === FULL_PAGE || arm === CLOSED_BOOK || arm in DEFAULT_ARM_SYSTEMS;

interface FileSource {
  files(): string[];
  file(path: string): Uint8Array;
}

const dec = new TextDecoder();
export const hexOf12 = (snapshotId: string): string => snapshotId.slice("sha256:".length, "sha256:".length + 12);

/** Reads the `markdown` bundle of `ts:measure.tokens`. */
export class MarkdownBundle {
  private readonly names: Set<string>;
  private readonly systems = new Set<string>();

  constructor(private readonly src: FileSource) {
    this.names = new Set(src.files());
    for (const f of this.names) {
      const m = /^out\/([^/]+)\//.exec(f);
      if (m) this.systems.add(m[1] as string);
    }
  }

  hasSystem(id: string): boolean {
    return this.systems.has(id);
  }

  systemIds(): string[] {
    return [...this.systems].sort();
  }

  /** D2 text of a page; undefined when the bundle has none. */
  d2(snapshotId: string): string | undefined {
    const p = `d2/${hexOf12(snapshotId)}.md`;
    return this.names.has(p) ? dec.decode(this.src.file(p)) : undefined;
  }

  /** Output of a system on a page: its text, or "" when the system has no output for the page (not covered). `covered` says which. */
  out(system: string, snapshotId: string): { text: string; covered: boolean } {
    const p = `out/${system}/${hexOf12(snapshotId)}.md`;
    return this.names.has(p) ? { text: dec.decode(this.src.file(p)), covered: true } : { text: "", covered: false };
  }
}

export interface ArmText {
  /** What the respondent sees as the page; null = closed book. */
  text: string | null;
  sha256: Sha256 | null;
  covered: boolean;
}

/** The page text of an arm for a snapshot. Throws on a pruned arm whose system the bundle does not know (a misnamed system must not look like an empty arm). */
export function armText(bundle: MarkdownBundle, arm: string, snapshotId: string, armSystems: Readonly<Record<string, string>>): ArmText {
  if (arm === CLOSED_BOOK) return { text: null, sha256: null, covered: true };
  if (arm === FULL_PAGE) {
    const d2 = bundle.d2(snapshotId);
    if (d2 === undefined) throw new Error(`the markdown bundle has no D2 for snapshot ${snapshotId}`);
    return { text: d2, sha256: sha256Of(d2), covered: true };
  }
  const system = armSystems[arm] ?? DEFAULT_ARM_SYSTEMS[arm];
  if (system === undefined) throw new Error(`unknown arm "${arm}"`);
  if (!bundle.hasSystem(system)) {
    throw new Error(`arm "${arm}" reads system "${system}", which the markdown bundle does not have (it has: ${bundle.systemIds().join(", ") || "none"}); name it with params.arm_systems`);
  }
  const o = bundle.out(system, snapshotId);
  return { text: o.text, sha256: sha256Of(o.text), covered: o.covered };
}

// ------------------------------------------------------------------------------------------------------ retention (M6)

export interface Retention {
  /** The quote occurs as a contiguous run of tokens in the arm's text (principal). */
  retained: boolean;
  /** Fraction of the quote's tokens present in the arm's text (secondary). */
  token_fraction: number;
}

/** Tokenizes arm texts once and answers the retention of any quote against them. */
export class RetentionIndex {
  private readonly cache = new Map<string, string[]>();
  private tokens(text: string): string[] {
    let t = this.cache.get(text);
    if (t === undefined) {
      t = retentionTokens(text);
      this.cache.set(text, t);
    }
    return t;
  }
  retention(armTextValue: string, quote: string): Retention {
    const hay = this.tokens(armTextValue);
    const q = retentionTokens(quote);
    return { retained: containsRun(hay, q), token_fraction: tokenFraction(hay, q) };
  }
}
