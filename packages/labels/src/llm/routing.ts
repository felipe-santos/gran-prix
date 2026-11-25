import { createHash } from "node:crypto";
import { THREE_CLASS_SPACE, type NodeLabels } from "@gran-prix/contracts";

/**
 * Routing by disagreement (protocol 5.2): which units of which pages are worth a paid call.
 *
 *  - Voters are the heuristic layers (`readability`, `heuristic`, `rule` kinds; Readability today, Trafilatura and
 *    Defuddle when they exist). Each votes keep/drop per unit; a unit it did not label is an ABSTENTION.
 *  - Units already settled by a human (or user feedback) layer are never routed: the merge would discard the LLM.
 *  - A unit goes to the LLM when the voters disagree or any abstains. Unanimous units are automatic (labels of
 *    the heuristic layers), except a deterministic CONTROL SAMPLE (default 15%, a hash of seed + snapshot + unit)
 *    that is sent anyway to catch the case where every extractor loses the same thing.
 *  - The WHOLE page goes when there are no voters, when a voter abstains on more than `abstain_page_frac` of the
 *    units (a discarded alignment abstains on all), or when a voter reports `readerable === false`.
 *  - `mode: "all"` sends every unit (the 30 audit pages: the LLM runs on all nodes).
 *
 * Pure and deterministic: same voters + same params = same routed set, in the same order, with the same reasons.
 */

export interface RoutingParams {
  mode: "disagreement" | "all";
  /** Fraction of unanimous units sent anyway. Default 0.15. */
  control_sample: number;
  /** Seed of the control sample hash. */
  seed: string;
  /** Abstention share of one voter above which the whole page is sent. Default 0.3. */
  abstain_page_frac: number;
}

export const DEFAULT_ROUTING: RoutingParams = { mode: "disagreement", control_sample: 0.15, seed: "gp-dom-v0-llm-control", abstain_page_frac: 0.3 };

export interface Voter {
  id: string;
  /** unit -> keep (1) / drop (0). Only units the voter decided. */
  votes: Map<number, 0 | 1>;
  /** Alignment `readerable` flag when the layer recorded one. */
  readerable?: boolean;
}

type Doc = NodeLabels & { alignment?: { discarded?: boolean; readerable?: boolean } };

const HEURISTIC_KINDS: ReadonlySet<string> = new Set(["readability", "heuristic", "rule"]);
const SETTLED_KINDS: ReadonlySet<string> = new Set(["human", "user_feedback"]);
const NOISE = THREE_CLASS_SPACE.classes.indexOf("noise");

/** Splits the layers of ONE snapshot into voters and the units already settled by humans. */
export function votersFromLabels(layers: readonly NodeLabels[]): { voters: Voter[]; settled: Set<number> } {
  const voters: Voter[] = [];
  const settled = new Set<number>();
  for (const l of layers as readonly Doc[]) {
    if (SETTLED_KINDS.has(l.labeler.kind)) {
      for (const it of l.items) settled.add(it.unit_id);
    } else if (HEURISTIC_KINDS.has(l.labeler.kind)) {
      const votes = new Map<number, 0 | 1>();
      const discarded = l.alignment?.discarded === true;
      if (!discarded) {
        for (const it of l.items) votes.set(it.unit_id, l.label_space.kind === "binary" ? (it.y === 1 ? 1 : 0) : it.y === NOISE ? 0 : 1);
      }
      const v: Voter = { id: l.labeler.id, votes };
      if (typeof l.alignment?.readerable === "boolean") v.readerable = l.alignment.readerable;
      voters.push(v);
    }
  }
  return { voters, settled };
}

export type RouteReason = "disagreement" | "abstention" | "control-sample" | "all" | `page-whole:${string}`;

export interface RoutingDecision {
  mode: RoutingParams["mode"];
  /** Why the whole page goes, or null. */
  page_whole: string | null;
  /** Routed unit -> reason, in ascending unit order. */
  routed: Map<number, RouteReason>;
  counts: {
    candidates: number;
    settled_by_human: number;
    routed: number;
    automatic: number;
    by_reason: Record<string, number>;
  };
  /** sha256 of the sorted routed unit ids: pins the decision without listing it. */
  routed_sha256: string;
}

function controlHit(seed: string, snapshotId: string, unit: number, frac: number): boolean {
  if (frac <= 0) return false;
  const h = createHash("sha256").update(`${seed}|${snapshotId}|${unit}`).digest();
  return h.readUInt32BE(0) / 2 ** 32 < frac;
}

export function routePage(
  snapshotId: string,
  candidates: readonly number[],
  voters: readonly Voter[],
  settled: ReadonlySet<number>,
  params: RoutingParams = DEFAULT_ROUTING,
): RoutingDecision {
  const units = [...new Set(candidates)].filter((u) => !settled.has(u)).sort((a, b) => a - b);
  const routed = new Map<number, RouteReason>();
  let pageWhole: string | null = null;

  if (params.mode === "all") {
    for (const u of units) routed.set(u, "all");
  } else {
    if (voters.length === 0) pageWhole = "no-voters";
    else if (voters.some((v) => v.readerable === false)) pageWhole = "not-readerable";
    else if (voters.some((v) => units.length > 0 && units.filter((u) => !v.votes.has(u)).length / units.length > params.abstain_page_frac)) {
      pageWhole = `abstention>${params.abstain_page_frac}`;
    }
    for (const u of units) {
      if (pageWhole !== null) {
        routed.set(u, `page-whole:${pageWhole}`);
        continue;
      }
      if (voters.some((v) => !v.votes.has(u))) routed.set(u, "abstention");
      else if (new Set(voters.map((v) => v.votes.get(u))).size > 1) routed.set(u, "disagreement");
      else if (controlHit(params.seed, snapshotId, u, params.control_sample)) routed.set(u, "control-sample");
    }
  }

  const by_reason: Record<string, number> = {};
  for (const r of routed.values()) by_reason[r] = (by_reason[r] ?? 0) + 1;
  return {
    mode: params.mode,
    page_whole: pageWhole,
    routed,
    counts: {
      candidates: candidates.length,
      settled_by_human: new Set(candidates.filter((u) => settled.has(u))).size,
      routed: routed.size,
      automatic: units.length - routed.size,
      by_reason,
    },
    routed_sha256: createHash("sha256").update([...routed.keys()].join(",")).digest("hex"),
  };
}
