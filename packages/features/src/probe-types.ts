// Shapes returned by the in-page probe. They are plain JSON and cross the Playwright / extension boundary.
import type { SnapNodeLike } from "./vectorize/types.js";
import type { SettleRecord } from "./probe/settle.js";

/** One non-blank text node, addressed "<owner id>#t<child index>" (see probe/walk.ts for the scheme). */
export interface TextUnit {
  id: string;
  /** idx of the owner element in `nodes`. */
  owner: number;
  /** Raw node value (not collapsed), made well-formed UTF-16. */
  t: string;
}

export interface ProbeOptions {
  /** DOM-quiet window, default 600. */
  quietMs?: number;
  /** Hard cap of the quiet wait, counted from the call, default 8000. */
  maxMs?: number;
  /** false = skip the wait (tests of the capture alone). Default true. */
  settle?: boolean;
  /** Write data-gp-id attributes into the DOM, default true. Needed for DOM-clone based labelers. */
  stamp?: boolean;
  /** Characters of own_text kept per element, default 1000 (own_text_len is measured before). */
  ownTextCap?: number;
  /** Wait before counting elements that appeared after stamping, default 250 ms. */
  lateCheckMs?: number;
}

export interface SettleReport extends Omit<SettleRecord, "reason"> {
  reason: SettleRecord["reason"] | "skipped";
  /** Elements present after the late check that carry no data-gp-id (added after stamping). */
  late_unstamped: number;
}

export interface RawProbe {
  page: {
    url: string;
    final_url: string;
    title?: string;
    lang?: string;
    og_type?: string;
    jsonld_types?: string[];
  };
  doc: { viewport_w: number; viewport_h: number; scroll_w: number; scroll_h: number };
  nodes: SnapNodeLike[];
  text_units: TextUnit[];
  /** Deterministic facts about the capture; part of the snapshot identity. */
  probe: { id_scheme: string; version: string; own_text_cap: number };
  /** Volatile facts (timings, mutation counts); goes to `capture`, outside the snapshot identity. */
  settle: SettleReport;
}

export const ID_SCHEME = "gp-composed-preorder/1";
export const PROBE_VERSION = "0.1.0";
