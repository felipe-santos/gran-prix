import {
  summarizeByStratum,
  type DenominatorSummary,
  type PageTokenRecord,
  type RatioStats,
} from "@gran-prix/markdown";

/**
 * Per-page token counts and their reduction statistics, in the shapes the EvalReport v1.1 already has
 * (`token_reduction` = `TokenReduction`, `per_group[].tokens_d1|tokens_d2|tokens_kept`), so the evaluate stage can
 * copy them in without translating anything.
 */

export interface PageTokens {
  snapshot_id: string;
  /** Dataset group id `<group_key>#<snapshot hex12>`: the join key with `per_group[].group_id`. */
  group_id: string;
  group_key: string;
  stratum: string;
  url_key: string;
  tokens_d1: number;
  tokens_d2: number;
  /** D2 with the content of collapsed disclosures included (sensitivity; equal to `tokens_d2` when the page has none). */
  tokens_d2_collapsed: number;
  /** Output tokens per system id (0 = empty output or page not covered). */
  tokens_out: Record<string, number>;
  /** Kept units per system id (size of the system's keep set on this page; null = not covered). */
  n_keep: Record<string, number | null>;
  /** Facts that qualify D1 and D2 on this page (see the README: D1 is a lower bound for scripts). */
  notes: {
    d1_bytes: number;
    script_elements: number;
    shadow_nodes: number;
    disclosure_nodes: number;
    unstamped_elements: number;
  };
}

type Ratio = Partial<{
  n_pages: number;
  median_ratio: number;
  iqr_ratio: [number, number];
  median_reduction: number;
  iqr_reduction: [number, number];
  pooled_ratio: number;
}>;

const ratioOf = (s: RatioStats): Ratio => ({
  n_pages: s.n_pages,
  ...(s.median_ratio !== null ? { median_ratio: s.median_ratio } : {}),
  ...(s.iqr_ratio !== null ? { iqr_ratio: s.iqr_ratio } : {}),
  ...(s.median_reduction !== null ? { median_reduction: s.median_reduction } : {}),
  ...(s.iqr_reduction !== null ? { iqr_reduction: s.iqr_reduction } : {}),
  ...(s.pooled_ratio !== null ? { pooled_ratio: s.pooled_ratio } : {}),
});

/** A `TokenDenominator` of the contract (nulls are left out: the fields are optional). */
function denominator(s: DenominatorSummary, description: string) {
  return {
    full_tokens: s.full_tokens,
    kept_tokens: s.kept_tokens,
    ...ratioOf(s),
    by_stratum: Object.fromEntries(Object.entries(s.by_stratum).map(([k, v]) => [k, ratioOf(v)])),
    description,
  };
}

export const EMPTY_OUTPUT_POLICY =
  "An empty output earns no credit: its page counts with reduction 0 (fraction kept 1) in the median, at full size in the pooled sums, and is counted in stats.*.n_empty.";

export interface SystemReport {
  id: string;
  origin: string;
  /** Pages the system had labels or predictions for. */
  pages_covered: number;
  /** The `token_reduction` block of an EvalReport v1.1 (D1 and D2 side by side; the product claim is D2). */
  token_reduction: {
    tokenizer: string;
    converter: string;
    d1: ReturnType<typeof denominator>;
    d2: ReturnType<typeof denominator>;
  };
  /** Everything behind it (n_empty, n_undefined, pooled reductions) and the D2-with-collapsed sensitivity. */
  stats: { d1: DenominatorSummary; d2: DenominatorSummary; d2_collapsed: DenominatorSummary };
}

const D1_DESCRIPTION =
  "D1: rendered, settled DOM serialization without data-gp-* attributes (the stored html: inline <script> content is emptied by the collector, so D1 is a lower bound there; open shadow roots are inlined). r_p = tok(D1)/tok(output).";
const D2_DESCRIPTION = "D2: full-page markdown (turndown + GFM, ATX headings, unrendered elements and collapsed disclosures removed, images as ![alt]()). The product claim is by D2. r_p = tok(D2)/tok(output).";

/** One system's block, from the per-page counts. */
export function systemReport(
  pages: readonly PageTokens[],
  system: { id: string; origin: string; pages_covered: number },
  labels: { tokenizer: string; converter: string },
): SystemReport {
  const rec = (full: (p: PageTokens) => number): PageTokenRecord[] => pages.map((p) => ({ stratum: p.stratum, full: full(p), out: p.tokens_out[system.id] ?? 0 }));
  const d1 = summarizeByStratum(rec((p) => p.tokens_d1));
  const d2 = summarizeByStratum(rec((p) => p.tokens_d2));
  const d2c = summarizeByStratum(rec((p) => p.tokens_d2_collapsed));
  return {
    id: system.id,
    origin: system.origin,
    pages_covered: system.pages_covered,
    token_reduction: {
      tokenizer: labels.tokenizer,
      converter: labels.converter,
      d1: denominator(d1, `${D1_DESCRIPTION} ${EMPTY_OUTPUT_POLICY}`),
      d2: denominator(d2, `${D2_DESCRIPTION} ${EMPTY_OUTPUT_POLICY}`),
    },
    stats: { d1, d2, d2_collapsed: d2c },
  };
}
