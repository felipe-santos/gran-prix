/**
 * Labels from the OUTPUT of any text extractor (Trafilatura, Defuddle, ...): the text the tool returned is aligned
 * back to the page's text units (`align.ts`, the same DP as Readability's), lifted to elements, and every element that
 * owns text gets main (kept) or noise (dropped). Extractors that return text or HTML without our `data-gp-id` stamp
 * can only be mapped this way; the alignment coverage travels with the result.
 *
 * Source/kind of the labels is `heuristic` (the labeler id says which tool and version); the h1-matches-title rule is
 * the same deterministic rule as for Readability (`source: "rule"`), switchable with `h1_title`.
 */
import { THREE_CLASS_SPACE, type NodeLabelItem } from "@gran-prix/contracts";
import { alignText, keptElements } from "./align.js";
import { parseFlattened } from "./dom.js";
import { eligibleUnits, type PageInput } from "./label-page.js";
import { buildNodeLabels, type NodeLabelsDoc } from "./node-labels.js";
import { DEFAULT_MIN_COVERAGE, applyH1TitleRule, type ElementDecision } from "./readability.js";

const MAIN = THREE_CLASS_SPACE.classes.indexOf("main");
const NOISE = THREE_CLASS_SPACE.classes.indexOf("noise");
const H1_RULE_CONFIDENCE = 0.95;

/** What an extractor produced for one page. `text: null` or blank = it returned nothing. */
export interface ExtractionOutput {
  text: string | null;
  /** Title the extractor found (feeds the h1 rule); the page `<title>` is the fallback. */
  title?: string | null;
}

export interface ExtractionLabelParams {
  /** Confidence stamped on the labels (P(label correct)). Default 0.7. */
  confidence?: number;
  /** Alignment coverage under which the page's labels are discarded (0 = never discard: baseline scoring). Default 0.9. */
  min_coverage?: number;
  /** Also keep units rescued by the order-free 2/3 rule. Default false. */
  fuzzy?: boolean;
  /** Apply the h1-matches-title rule. Default true (the same post-step Readability gets). */
  h1_title?: boolean;
}

export interface ExtractionLabeler {
  /** Labeler id, e.g. `trafilatura@2.4.0:recall`. */
  id: string;
  /** Hashed into `labeler.params_sha256`. */
  params: unknown;
  /** Extra document fields (e.g. `extraction`: tool version, options, router decision). Part of `labels_id`. */
  extra?: Record<string, unknown>;
}

export type ExtractionStatus = "ok" | "no-output" | "low-coverage";

/**
 * Labels of one page from an extractor's output. When the output is blank or the alignment coverage is under
 * `min_coverage` the page gets NO items (status `no-output` / `low-coverage`, `alignment.discarded: true`). With
 * `min_coverage: 0` a blank output still yields labels: every unit is dropped, which is what an empty extraction
 * means for a baseline (protocol 6.2: empty output scores F1 = 0, never 1).
 */
export function labelPageExtraction(
  page: PageInput,
  out: ExtractionOutput,
  labeler: ExtractionLabeler,
  params: ExtractionLabelParams = {},
): NodeLabelsDoc {
  const { snapshot, features } = page;
  const candidates = eligibleUnits(snapshot, features);
  const confidence = params.confidence ?? 0.7;
  const minCoverage = params.min_coverage ?? DEFAULT_MIN_COVERAGE;
  const h1Title = params.h1_title ?? true;
  const flat = parseFlattened(page.html, snapshot.page.final_url);
  const owners = [...flat.ownText.keys()].sort((a, b) => a - b);
  const blank = (out.text ?? "").trim() === "";

  const decisions = new Map<number, ElementDecision>();
  let coverage = 0;
  let exact = 0;
  let fuzzy = 0;
  if (blank) {
    for (const o of owners) decisions.set(o, { kept: false, via: null });
  } else {
    const al = alignText(flat.texts, out.text as string);
    coverage = al.coverage;
    exact = al.exact.size;
    fuzzy = al.fuzzy.size;
    const kept = keptElements(flat.texts, new Set([...al.exact, ...(params.fuzzy ? al.fuzzy : [])]));
    for (const o of owners) decisions.set(o, { kept: kept.has(o), via: kept.has(o) ? "text" : null });
    if (h1Title) applyH1TitleRule(flat, owners, decisions, out.title || flat.title);
  }
  const status: ExtractionStatus = coverage >= minCoverage ? "ok" : blank ? "no-output" : "low-coverage";
  const items: NodeLabelItem[] = [];
  if (status === "ok") {
    for (const unit_id of candidates) {
      const d = decisions.get(unit_id);
      if (!d) continue;
      if (d.via === "h1-title") items.push({ unit_id, y: MAIN, confidence: H1_RULE_CONFIDENCE, source: "rule", reason: "rule:h1=title" });
      else items.push({ unit_id, y: d.kept ? MAIN : NOISE, confidence, source: "heuristic", reason: d.kept ? "ex:text" : "ex:dropped" });
    }
  }
  return buildNodeLabels({
    snapshot_id: snapshot.snapshot_id,
    labeler: {
      id: labeler.id,
      kind: "heuristic",
      params: { ...(labeler.params as object), confidence, min_coverage: minCoverage, fuzzy: params.fuzzy ?? false, h1_title: h1Title },
    },
    items,
    n_candidates: candidates.length,
    extra: {
      alignment: {
        status,
        discarded: status !== "ok",
        coverage: Math.round(coverage * 1e6) / 1e6,
        min_coverage: minCoverage,
        exact_units: exact,
        fuzzy_units: fuzzy,
        output_chars: (out.text ?? "").trim().length,
      },
      ...labeler.extra,
    },
  });
}
