// Turns what the page returned (RawProbe + flattened html) into the pair the collect stage stores per page:
// a contract-shaped PageSnapshot and the gzipped html. Pure apart from the clock default; no chrome.* here, so the
// node tests import it as is. Everything it calls is the collector's own code (built dist of the sibling packages;
// see scripts/build.mjs for how the bundle swaps `node:crypto` / `node:zlib` for shims).
import { canonicalJson, sha256Of } from "@gran-prix/contracts";
import { buildPageSnapshot, defaultUrlKey } from "../../../packages/features/dist/node/snapshot.js";
import { htmlFileRef } from "../../cli/dist/stages/collect/flatten.js";
import { pageFlags } from "../../cli/dist/stages/collect/flags.js";
import { registrableDomain } from "../../cli/dist/stages/collect/group-key.js";
import { htmlPath } from "../../../packages/labels/dist/set-readers.js";

export const COLLECTOR_VERSION = "gp-capture-ext/0.1.0";
export const STRATUM = "logged_in";
/** The settle the collector uses, minus the load/networkidle steps (the page is already loaded when the owner clicks). */
export const SETTLE = { quietMs: 600, maxMs: 8000 };
export const WAIT_STRATEGY = `extension-click+dom-quiet(${SETTLE.quietMs}ms,cap ${SETTLE.maxMs}ms)`;

const utf8 = new TextEncoder();

/**
 * Query string and fragment are dropped from every stored URL: in a logged-in app they carry session tokens, share
 * keys and document ids that the snapshot has no use for. (The collector keeps the full URL; its pages are public.)
 */
export function stripUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? `${u.origin}${u.pathname}` : url;
  } catch {
    return url;
  }
}

/** "131.0.6778.86" out of a user agent such as "... Chrome/131.0.0.0 ...". */
export function chromeVersionOf(userAgent) {
  return /(?:Chrome|Chromium)\/([\d.]+)/.exec(userAgent)?.[1] ?? "unknown";
}

/**
 * @param {object} input
 * @param {import("../../../packages/features/dist/probe-types.js").RawProbe} input.raw
 * @param {{ html: string, shadow_hosts_inlined: number }} input.flat
 * @param {string} input.userAgent
 * @param {string} [input.browserVersion] full version when the browser reports it (userAgentData), else taken from the UA
 * @param {number} input.status HTTP status of the navigation, 0 when unknown (recorded as 200: the page is on screen)
 * @param {string} [input.capturedAt] RFC 3339, default the clock
 */
export function buildCapture({ raw, flat, userAgent, browserVersion, status, capturedAt }) {
  const url = stripUrl(raw.page.url);
  const finalUrl = stripUrl(raw.page.final_url);
  const host = new URL(finalUrl).hostname;
  const httpStatus = status >= 100 && status <= 599 ? status : 200;
  const flags = pageFlags({ title: raw.page.title, http_status: httpStatus, nodes: raw.nodes });
  const html = htmlFileRef(htmlPath(sha256Of(flat.html)), flat.html);
  // Volatile settle facts stay out of the stored snapshot, exactly as in the collect stage.
  const { waited_ms: _waited, mutations: _mutations, ...stableSettle } = raw.settle;
  const snapshot = buildPageSnapshot(
    { ...raw, page: { ...raw.page, url, final_url: finalUrl }, settle: stableSettle },
    {
      url,
      url_key: defaultUrlKey(finalUrl),
      group_key: registrableDomain(host, true),
      category: STRATUM,
      html,
      capture: {
        collector_version: COLLECTOR_VERSION,
        browser: { name: "chromium", version: browserVersion ?? chromeVersionOf(userAgent) },
        user_agent: userAgent,
        http_status: httpStatus,
        captured_at: capturedAt ?? new Date().toISOString(),
        wait_strategy: WAIT_STRATEGY,
        extra: {
          flags,
          shadow_hosts_inlined: flat.shadow_hosts_inlined,
          network: "skipped",
          capture_mode: "extension-active-tab",
          authenticated_session: true,
          http_status_source: status >= 100 && status <= 599 ? "navigation-timing" : "assumed-200",
        },
      },
    },
  );
  return { snapshot, snapshotText: `${canonicalJson(snapshot)}\n`, html: flat.html, flags };
}

/** gzip of a string with the platform's CompressionStream (the import re-gzips with zlib; only the decoded bytes matter). */
export async function gzipText(text) {
  const stream = new Blob([utf8.encode(text)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** `<hex of snapshot_id>`: the base name of both files of a capture. */
export function baseNameOf(snapshotId) {
  return snapshotId.replace(/^sha256:/, "");
}
