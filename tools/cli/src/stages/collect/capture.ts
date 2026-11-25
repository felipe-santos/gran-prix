import { canonicalJson, sha256Of, validate, type PageSnapshot } from "@gran-prix/contracts";
import { FLATTEN_SOURCE, gzipHtml, htmlFileRef, type FlattenedPage } from "./flatten.js";
import { pageFlags } from "./flags.js";
import { htmlPath, snapshotPath, type SnapshotSetEntry, type SnapshotSetFailure } from "./snapshot-set.js";
import { groupKeyOf, type Target } from "./target.js";
import type { UrlEntry } from "./url-list.js";

/** `@gran-prix/features` is loaded on demand: `gp validate` and the other stages never pay for Playwright. */
export type FeaturesModule = typeof import("@gran-prix/features");
type Browser = Awaited<ReturnType<FeaturesModule["launch"]>>["browser"];

export const COLLECTOR_VERSION = "gp-collect/1.0.0";

export interface CaptureOptions {
  features: FeaturesModule;
  /** Source of the in-page bundle, injected at document start into every page. */
  bundle: string;
  viewport: { width: number; height: number };
  quietMs: number;
  maxMs: number;
  networkIdleCapMs: number;
  navTimeoutMs: number;
  maxNodes: number | undefined;
  /** RFC 3339; pinned by `captured_at` or read from the clock when the page is captured. */
  capturedAt: string | undefined;
  waitLabel: string | undefined;
  privateSuffixes: boolean;
}

export class CaptureError extends Error {
  constructor(readonly reason: SnapshotSetFailure["reason"], message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

export interface CapturedPage {
  entry: SnapshotSetEntry;
  /** Files of the set contributed by this page (artifact-relative path -> bytes). */
  files: Record<string, Uint8Array | string>;
  /** Volatile facts for the log (timings, mutation counts); deliberately NOT stored. */
  note: string;
}

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";

/**
 * Loads one page in a fresh browser context (no cookies or storage shared between pages), settles it,
 * stamps `data-gp-id`, probes it and builds a contract-valid PageSnapshot plus the gzipped flattened
 * html. Throws `CaptureError` when the page cannot become a snapshot.
 */
export async function capturePage(browser: Browser, entry: UrlEntry, target: Target, o: CaptureOptions): Promise<CapturedPage> {
  const { features } = o;
  const context = await browser.newContext({ viewport: o.viewport });
  try {
    await context.addInitScript({ content: o.bundle });
    const page = await context.newPage();

    let status = 0;
    try {
      const response = await page.goto(target.navUrl, { waitUntil: "load", timeout: o.navTimeoutMs });
      status = response?.status() ?? 0;
    } catch (e) {
      throw new CaptureError("navigation", firstLine(e));
    }

    let probed: Awaited<ReturnType<FeaturesModule["probeLoadedPage"]>>;
    let flat: FlattenedPage;
    let userAgent: string;
    try {
      probed = await features.probeLoadedPage(page, { quietMs: o.quietMs, maxMs: o.maxMs, networkIdleCapMs: o.networkIdleCapMs });
      flat = (await page.evaluate(FLATTEN_SOURCE)) as FlattenedPage;
      userAgent = (await page.evaluate("navigator.userAgent")) as string;
    } catch (e) {
      throw new CaptureError("capture", firstLine(e));
    }

    const raw = probed.raw;
    if (o.maxNodes !== undefined && raw.nodes.length > o.maxNodes) {
      throw new CaptureError("max_nodes", `${raw.nodes.length} elements exceed max_nodes=${o.maxNodes}`);
    }
    const browserFinal = raw.page.final_url;
    const finalUrl = target.logicalUrl ?? browserFinal;
    const httpStatus = status >= 100 && status <= 599 ? status : 200; // file: loads report no HTTP status
    const flags = pageFlags({
      title: raw.page.title,
      http_status: httpStatus,
      nodes: raw.nodes,
    });

    const html = htmlFileRef(htmlPath(sha256Of(flat.html)), flat.html);
    // Volatile settle facts (waited_ms, mutation counts) stay in the log: stored, they would make every
    // re-collect of an unchanged page a different artifact.
    const { waited_ms, mutations, ...stableSettle } = raw.settle;
    const snapshot = features.buildPageSnapshot(
      { ...raw, page: { ...raw.page, final_url: finalUrl }, settle: stableSettle as typeof raw.settle },
      {
        url: target.logicalUrl ?? entry.url,
        url_key: features.defaultUrlKey(finalUrl),
        group_key: groupKeyOf(entry, target, browserFinal, o.privateSuffixes),
        category: entry.stratum,
        html,
        capture: {
          collector_version: COLLECTOR_VERSION,
          browser: { name: "chromium", version: browser.version() },
          user_agent: userAgent,
          http_status: httpStatus,
          captured_at: o.capturedAt ?? new Date().toISOString(),
          wait_strategy: `load+networkidle(<=${o.networkIdleCapMs}ms)+dom-quiet(${o.quietMs}ms,cap ${o.maxMs}ms)${o.waitLabel ? ` [${o.waitLabel}]` : ""}`,
          extra: { flags, shadow_hosts_inlined: flat.shadow_hosts_inlined },
        },
      },
    ) as PageSnapshot;

    const checked = validate("page-snapshot", snapshot);
    if (!checked.ok) {
      const first = checked.issues[0];
      throw new CaptureError("capture", `snapshot is not contract-valid: ${first ? `${first.path}: ${first.message}` : "?"}`);
    }

    const setEntry: SnapshotSetEntry = {
      snapshot_id: snapshot.snapshot_id,
      url: snapshot.page.url,
      final_url: snapshot.page.final_url,
      stratum: entry.stratum,
      group_key: snapshot.page.group_key,
      http_status: httpStatus,
      flags,
      node_count: snapshot.nodes.length,
      snapshot: snapshotPath(snapshot.snapshot_id),
      html: html.path,
    };
    return {
      entry: setEntry,
      files: { [setEntry.snapshot]: `${canonicalJson(snapshot)}\n`, [html.path]: gzipHtml(flat.html) },
      note: `${snapshot.nodes.length} nodes, settle ${raw.settle.reason} after ${waited_ms} ms (${mutations} mutations), ${flat.shadow_hosts_inlined} shadow hosts inlined${flags.length > 0 ? `, flags: ${flags.join(",")}` : ""}`,
    };
  } finally {
    await context.close();
  }
}
