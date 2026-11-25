export { d1Html, stripGpAttributes } from "./d1.js";
export { PageDom, TURNDOWN_OPTIONS, htmlToMarkdown, type ConvertOptions, type Converted } from "./convert.js";
export { ACT_CONTAINER, ACT_DROP, ACT_FULL, D2_REMOVED_TAGS, planPage, type Act, type Plan, type PlanOptions } from "./plan.js";
export { NON_CONTENT_TAGS, effectiveOpacities, isRenderedNode } from "./rendered.js";
export { TOKENIZER_NAME, countTokens, encodeTokens } from "./tokens.js";
export {
  CONVERTER_VERSION,
  converterDigests,
  converterLabel,
  converterVersions,
  tokenizerLabel,
  type ConverterVersions,
} from "./versions.js";
export {
  iqr,
  median,
  quantile,
  summarizeByStratum,
  summarizeRatios,
  type DenominatorSummary,
  type PageTokenPair,
  type PageTokenRecord,
  type RatioStats,
} from "./reduction.js";
export {
  FakeClaudeTransport,
  claudeOverhead,
  countTokensClaude,
  tokenDrift,
  type ClaudeCountRequest,
  type ClaudeTokenTransport,
  type TokenDrift,
} from "./claude.js";
export { COLLAPSED_CONTENT_IN_D2 } from "./policy.js";
export type { CollapsedPolicy, NodeLike } from "./types.js";
