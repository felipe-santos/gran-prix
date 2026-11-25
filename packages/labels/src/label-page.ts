import { THREE_CLASS_SPACE, type NodeFeatures, type NodeLabelItem, type PageSnapshot } from "@gran-prix/contracts";
import { buildNodeLabels, type NodeLabelsDoc } from "./node-labels.js";
import { DEFAULT_MIN_COVERAGE, readabilityLabel, type KeptVia } from "./readability.js";
import { classIndex, importTruth, type TruthRule } from "./truth.js";

/** One page as the labelers see it: the snapshot, its feature rows and the flattened HTML. */
export interface PageInput {
  snapshot: PageSnapshot;
  features: NodeFeatures;
  /** Flattened HTML of the snapshot (open shadow roots inlined, every element stamped `data-gp-id`). */
  html: string;
}

const MAIN = THREE_CLASS_SPACE.classes.indexOf("main");
const NOISE = THREE_CLASS_SPACE.classes.indexOf("noise");

/**
 * The units a labeler is asked about: feature rows of elements that own text (ADR-006 addendum: the
 * unit of the label is the element with own text). Strictly increasing snapshot idx.
 */
export function eligibleUnits(snapshot: PageSnapshot, features: NodeFeatures): number[] {
  if (features.snapshot_id !== snapshot.snapshot_id) {
    throw new Error(`features ${features.features_id} belong to snapshot ${features.snapshot_id}, not ${snapshot.snapshot_id}`);
  }
  return features.unit_ids.filter((idx) => (snapshot.nodes[idx]?.own_text_len ?? 0) > 0);
}

export interface ReadabilityLabelParams {
  /** Confidence stamped on Readability labels (P(label correct)). Default 0.7. */
  confidence?: number;
  /** Alignment coverage under which the page's labels are discarded. Default 0.9. */
  min_coverage?: number;
  /** Also keep units rescued by the order-free 2/3 rule. Default false. */
  fuzzy?: boolean;
  /** Apply the h1-matches-title rule. Default true. */
  h1_title?: boolean;
}

export const READABILITY_LABELER_ID = "readability-jsdom@1.0.0";
export const TRUTH_LABELER_ID = "truth-selectors@1.0.0";
const H1_RULE_CONFIDENCE = 0.95;

/**
 * Readability labels in the 3-class space: kept -> main, not kept -> noise (Readability cannot tell
 * support from main; the binary projection keep = main + support is unaffected). The h1-title rule
 * is a deterministic rule (`source: "rule"`). When Readability returns nothing, or its text is not
 * explained by the page (coverage below `min_coverage`), NO label is emitted and the record says why.
 */
export function labelPageReadability(page: PageInput, params: ReadabilityLabelParams = {}): NodeLabelsDoc {
  const { snapshot, features } = page;
  const candidates = eligibleUnits(snapshot, features);
  const confidence = params.confidence ?? 0.7;
  const minCoverage = params.min_coverage ?? DEFAULT_MIN_COVERAGE;
  const res = readabilityLabel(page.html, {
    url: snapshot.page.final_url,
    fuzzy: params.fuzzy ?? false,
    h1Title: params.h1_title ?? true,
    minCoverage,
  });
  const items: NodeLabelItem[] = [];
  if (res.status === "ok") {
    for (const unit_id of candidates) {
      const d = res.decisions.get(unit_id);
      if (!d) continue;
      if (d.via === "h1-title") {
        items.push({ unit_id, y: MAIN, confidence: H1_RULE_CONFIDENCE, source: "rule", reason: "rule:h1=title" });
      } else {
        items.push({ unit_id, y: d.kept ? MAIN : NOISE, confidence, source: "readability", reason: reason(d.via) });
      }
    }
  }
  return buildNodeLabels({
    snapshot_id: snapshot.snapshot_id,
    labeler: {
      id: READABILITY_LABELER_ID,
      kind: "readability",
      params: { confidence, min_coverage: minCoverage, fuzzy: params.fuzzy ?? false, h1_title: params.h1_title ?? true },
    },
    items,
    n_candidates: candidates.length,
    extra: {
      alignment: {
        status: res.status,
        discarded: res.status !== "ok",
        coverage: res.alignment.coverage,
        min_coverage: minCoverage,
        readerable: res.readerable,
        exact_units: res.alignment.exact_units,
        fuzzy_units: res.alignment.fuzzy_units,
        ids_kept: res.alignment.ids_kept,
      },
    },
  });
}

const reason = (via: KeptVia | null): string => (via === null ? "rd:dropped" : `rd:${via}`);

export interface TruthLabelParams {
  /** Confidence of imported labels. Default 1 (a human wrote them). */
  confidence?: number;
}

/**
 * Truth importer as a labeler: `label_source: "human"`. `rules` null (the page has no truth) yields a
 * labels document with no items. Candidates no rule covers stay unlabeled; their count is recorded.
 */
export function labelPageTruth(page: PageInput, rules: readonly TruthRule[] | null, params: TruthLabelParams = {}): NodeLabelsDoc {
  const { snapshot, features } = page;
  const candidates = eligibleUnits(snapshot, features);
  const confidence = params.confidence ?? 1;
  const items: NodeLabelItem[] = [];
  let extra: Record<string, unknown> = { truth_import: { has_rules: false } };
  if (rules !== null) {
    const imp = importTruth(page.html, rules, { url: snapshot.page.final_url });
    let uncovered = 0;
    for (const unit_id of candidates) {
      const c = imp.labels.get(unit_id) ?? null;
      if (c === null) {
        uncovered++;
        continue;
      }
      items.push({ unit_id, y: classIndex(c), confidence, source: "human", reason: `truth:${c}` });
    }
    extra = {
      truth_import: {
        has_rules: true,
        uncovered_candidates: uncovered,
        dead_rules: imp.deadRules,
        invalid_rules: imp.invalidRules,
      },
    };
  }
  return buildNodeLabels({
    snapshot_id: snapshot.snapshot_id,
    labeler: { id: TRUTH_LABELER_ID, kind: "human", params: { confidence, rules: rules ?? null } },
    items,
    n_candidates: candidates.length,
    extra,
  });
}
