import { Type, type Static } from "@sinclair/typebox";
import { NonNegInt, PosInt, Unit01 } from "./base.js";
import { Ci95, MetricCisBody, NoteBody } from "./stats.js";

/**
 * EvalReport v1.1 additions (all optional). They mirror the "extras" sidecar of `@gran-prix/report`
 * (`metric_ci`, `pr_curve`, `token_reduction`, `gate_details`, `names`, `notes`), so the renderer can drop the
 * sidecar: a field name here is the sidecar's name wherever one existed.
 */

/** What evaluated (C11): the trained model, a baseline, or the oracle (gold fed through the same converter). */
export const EvalSystem = Type.Object({
  kind: Type.Union([Type.Literal("model"), Type.Literal("baseline"), Type.Literal("oracle")]),
  family: Type.Optional(Type.String({ description: "Free label: mlp | gbdt | extractor | router | readability | ..." })),
  name: Type.Optional(Type.String()),
  version: Type.Optional(Type.String()),
});
export type EvalSystem = Static<typeof EvalSystem>;

export const EvalNames = Type.Object({ model: Type.Optional(Type.String()), dataset: Type.Optional(Type.String()) });

/** Which unit `n`, `tp`, `fp`, `tn`, `fn` count (C1). v1.0 left it implicit. */
export const Weighting = Type.Union([Type.Literal("chars"), Type.Literal("elements"), Type.Literal("tokens")]);

export const PrPoint = Type.Object({ threshold: Unit01, precision: Unit01, recall: Unit01 });
export const PrCurve = Type.Object({
  points: Type.Array(PrPoint, { minItems: 2, description: "Sorted by threshold ascending." }),
  operating_threshold: Type.Optional(Unit01),
  operating_rule: Type.Optional(Type.String({ description: "How the operating point was chosen, e.g. 'max threshold with char-weighted recall >= 0.95 on dev OOF'." })),
});

/** CIs of the per-stratum metrics; `overall` is an allowed stratum key. */
export const MetricCiTable = Type.Object({
  model: Type.Optional(Type.Record(Type.String(), MetricCisBody)),
  baselines: Type.Optional(Type.Record(Type.String(), Type.Record(Type.String(), MetricCisBody))),
});

/** Median / IQR of a per-page ratio. */
const RatioSummary = {
  n_pages: Type.Optional(NonNegInt),
  median_ratio: Type.Optional(Type.Number({ minimum: 0, description: "Median over pages of kept/full (the fraction kept)." })),
  iqr_ratio: Type.Optional(Ci95),
  median_reduction: Type.Optional(Type.Number({ minimum: 0, description: "Median over pages of full/kept (the 'x times fewer tokens' of gate G4)." })),
  iqr_reduction: Type.Optional(Ci95),
  pooled_ratio: Type.Optional(Type.Number({ minimum: 0, description: "sum(kept) / sum(full): secondary, dominated by large pages." })),
};

export const TokenDenominator = Type.Object({
  full_tokens: NonNegInt,
  kept_tokens: NonNegInt,
  ...RatioSummary,
  by_stratum: Type.Optional(Type.Record(Type.String(), Type.Object(RatioSummary))),
  description: Type.Optional(Type.String()),
});
export type TokenDenominator = Static<typeof TokenDenominator>;

/** G4 / M5: D1 = rendered raw HTML (outerHTML post-settle), D2 = full-page markdown (conservative floor). */
export const TokenReduction = Type.Object({
  tokenizer: Type.String({ minLength: 1 }),
  converter: Type.Optional(Type.String({ description: "Markdown converter + version used for D2 and the kept text, e.g. 'turndown@7.2.0+gfm'." })),
  d1: Type.Optional(TokenDenominator),
  d2: Type.Optional(TokenDenominator),
});
export type TokenReduction = Static<typeof TokenReduction>;

/** G5: latency and size of the shipped model (C8). */
export const RuntimeBlock = Type.Object({
  p95_ms: Type.Number({ minimum: 0 }),
  model_bytes: NonNegInt,
  n_pages: PosInt,
  p50_ms: Type.Optional(Type.Number({ minimum: 0 })),
  cpu_throttle: Type.Optional(Type.Number({ minimum: 1, description: "CPU slowdown factor, e.g. 4." })),
  repetitions: Type.Optional(PosInt),
  environment: Type.Optional(Type.String({ description: "e.g. 'chromium-headless 130, 4x CPU throttle'." })),
  page_elements: Type.Optional(Type.Tuple([NonNegInt, NonNegInt], { description: "[min, max] elements of the measured pages." })),
});

/** C3: a named group of strata ('hard') with its micro and macro views. */
export const Aggregate = Type.Object({
  name: Type.String({ minLength: 1 }),
  strata: Type.Array(Type.String(), { minItems: 1 }),
  macro_page_f1: Type.Optional(Unit01),
  macro_stratum_f1: Type.Optional(Unit01),
  ci95: Type.Optional(Ci95),
});

/** QA: share of questions whose evidence survives in an arm's output (M6). */
export const EvidenceRetention = Type.Object({
  mean: Unit01,
  ci95: Type.Optional(Ci95),
  n_questions: Type.Optional(NonNegInt),
  token_fraction_mean: Type.Optional(Unit01),
  by_stratum: Type.Optional(Type.Record(Type.String(), Type.Object({ mean: Unit01, n_questions: NonNegInt }))),
});

export const EvalNotes = Type.Array(NoteBody);

