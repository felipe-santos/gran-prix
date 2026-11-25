// Node side: turns the probe's RawProbe + capture metadata into a PageSnapshot document and hashes it.
import { contractId, type FileRef, type PageSnapshot } from "@gran-prix/contracts";
import type { RawProbe, TextUnit } from "../probe-types.js";

/** Contract fields plus the extensions this package emits (the contract schemas are open). */
export type PageSnapshotDoc = PageSnapshot & {
  /** Every non-blank light-DOM text node, addressed "<owner id>#t<child index>". Proposed contract field. */
  text_units: TextUnit[];
  /** Deterministic probe facts (id scheme, own_text cap). Proposed contract field. */
  probe: RawProbe["probe"];
};

export interface CaptureMeta {
  collector_version: string;
  browser: { name: "chromium"; version: string };
  user_agent: string;
  http_status: number;
  /** RFC 3339 timestamp; lives in `capture`, outside the snapshot id. */
  captured_at: string;
  wait_strategy?: string;
  scrolled_to_bottom?: boolean;
  truncated?: boolean;
  /** Anything else worth keeping with the capture (network-idle outcome, timings). */
  extra?: Record<string, unknown>;
}

export interface BuildSnapshotOptions {
  /** The URL that was requested; defaults to the probe's `page.url`. */
  url?: string;
  category: string;
  url_key?: string;
  group_key?: string;
  /** Reference to the stored rendered HTML (the collector writes it, gzipped, next to the snapshot). */
  html: FileRef;
  capture: CaptureMeta;
}

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src)$/i;

/** Lowercase host, no fragment, no tracking parameters. */
export function defaultUrlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

/** Host without a leading "www."; "local" for file: URLs. Real eTLD+1 grouping belongs to the collector. */
export function defaultGroupKey(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname ? u.hostname.replace(/^www\./i, "").toLowerCase() : "local";
  } catch {
    return "local";
  }
}

export function buildPageSnapshot(raw: RawProbe, opts: BuildSnapshotOptions): PageSnapshotDoc {
  const url = opts.url ?? raw.page.url;
  const { reason, ...settleRest } = raw.settle;
  const waitStrategy = opts.capture.wait_strategy ?? "load+networkidle(<=3s)+dom-quiet(600ms,cap 8s)";
  const body = {
    format: "gran-prix.page-snapshot" as const,
    format_version: "1.0.0" as const,
    page: {
      ...raw.page,
      url,
      url_key: opts.url_key ?? defaultUrlKey(raw.page.final_url),
      group_key: opts.group_key ?? defaultGroupKey(raw.page.final_url),
      category: opts.category,
    },
    doc: raw.doc,
    nodes: raw.nodes as unknown as PageSnapshot["nodes"],
    html: opts.html,
    text_units: raw.text_units,
    probe: raw.probe,
    capture: {
      captured_at: opts.capture.captured_at,
      collector_version: opts.capture.collector_version,
      browser: opts.capture.browser,
      user_agent: opts.capture.user_agent,
      http_status: opts.capture.http_status,
      wait_strategy: waitStrategy,
      scrolled_to_bottom: opts.capture.scrolled_to_bottom ?? false,
      truncated: opts.capture.truncated ?? false,
      auth: "none" as const,
      settle: { reason, ...settleRest },
      ...opts.capture.extra,
    },
  };
  const withoutId = body as unknown as Record<string, unknown>;
  const snapshot_id = contractId("page-snapshot", withoutId);
  return { snapshot_id, ...body } as PageSnapshotDoc;
}
