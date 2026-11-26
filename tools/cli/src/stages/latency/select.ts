import { createHash } from "node:crypto";

/**
 * Page selection of the G5 measurement (protocol section 8, row G5): the pages of the frozen SnapshotSet with
 * 1,500 to 3,000 elements, in the order of `sha256(order_prefix + url)`, the first `count` of them. The order is a
 * function of the url alone, so the same corpus always gives the same pages, whatever the machine or the run.
 */

/** Frozen with the experiment: `gp-dom-v0|<seed>|g5|`. */
export const G5_ORDER_PREFIX = "gp-dom-v0|20261125|g5|";
export const G5_MIN_ELEMENTS = 1500;
export const G5_MAX_ELEMENTS = 3000;
export const G5_MIN_PAGES = 20;

export interface Candidate {
  snapshot_id: string;
  url: string;
  /** `nodes.length` of the stored snapshot (the probe's own element count). */
  nodes: number;
}

export interface Selection<T extends Candidate> {
  /** Selected pages, in order of the hash. */
  selected: Array<T & { rank: number; order_key: string }>;
  /** Pages of the set inside the element range. */
  eligible: number;
  /** Pages in the set. */
  total: number;
  /** True when fewer than `count` pages are inside the range (all of them are used). */
  shortfall: boolean;
}

export function orderKey(prefix: string, url: string): string {
  return createHash("sha256").update(prefix + url, "utf8").digest("hex");
}

export interface SelectOptions {
  orderPrefix?: string;
  minElements?: number;
  maxElements?: number;
  count?: number;
}

export function selectPages<T extends Candidate>(candidates: readonly T[], o: SelectOptions = {}): Selection<T> {
  const prefix = o.orderPrefix ?? G5_ORDER_PREFIX;
  const lo = o.minElements ?? G5_MIN_ELEMENTS;
  const hi = o.maxElements ?? G5_MAX_ELEMENTS;
  const count = o.count ?? G5_MIN_PAGES;
  if (!(lo <= hi)) throw new Error(`element range [${lo}, ${hi}] is empty`);
  if (!Number.isInteger(count) || count < 1) throw new Error(`page count must be a positive integer, got ${count}`);
  const inRange = candidates
    .filter((c) => c.nodes >= lo && c.nodes <= hi)
    .map((c) => ({ ...c, order_key: orderKey(prefix, c.url) }))
    // Ties (two snapshots of one url) are broken by the snapshot id, so the order stays total.
    .sort((a, b) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : a.snapshot_id < b.snapshot_id ? -1 : 1));
  const selected = inRange.slice(0, count).map((c, i) => ({ ...c, rank: i + 1 }));
  return { selected, eligible: inRange.length, total: candidates.length, shortfall: inRange.length < count };
}
