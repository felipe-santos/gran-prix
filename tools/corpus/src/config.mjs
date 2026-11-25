// Frozen constants of the pre-registered protocol (experimento-dom-v0.md, tag prereg-dom-v0).
// Nothing here is tunable: a change is a registered deviation, not an edit.
import { join } from "node:path";

/** §2.3: ordering seed (20261125) and the exact hash prefix. */
export const SEED = 20261125;
export const ORDER_PREFIX = `gp-dom-v0|${SEED}|`;

/** §2.1: categories in the order of the table; `n` is the target of the public stratum (170 in total). */
export const CATEGORIES = [
  { name: "article", n: 30 },
  { name: "product", n: 30 },
  { name: "docs", n: 30 },
  { name: "forum", n: 30 },
  { name: "landing", n: 25 },
  { name: "spa", n: 25 },
];
export const TOTAL_TARGET = CATEGORIES.reduce((a, c) => a + c.n, 0);

/** §2.3.1: WCXB page type -> category. listing/collection do not enter the frame. */
export const WCXB_TYPE_TO_CATEGORY = {
  article: "article",
  product: "product",
  documentation: "docs",
  forum: "forum",
  service: "landing",
};
export const WCXB_EXCLUDED_TYPES = ["listing", "collection"];

/** §2.2 / §2.1 thresholds. */
export const MIN_VISIBLE_CHARS = 300;
export const MAX_TEXT_ELEMENTS = 5000;
export const SPA_SERVER_MAX_CHARS = 200; // server HTML: strictly fewer
export const SPA_RENDERED_MIN_CHARS = 1000; // after hydration: strictly more
export const MAX_PER_DOMAIN_CATEGORY = 1;
export const MAX_PER_DOMAIN = 2;
/** Owner-approved language mix: en >= 70%, pt/es <= 30% (applied per category, see README). */
export const MAX_NON_EN_SHARE = 0.3;
export const LANGS_ALLOWED = ["en", "pt", "es"];

/** §4 capture settings. */
export const VIEWPORT = { width: 1366, height: 900 };
export const LOCALE = "en-US";

/** Politeness: a generic research user agent (no personal or project identifiers). */
export const ROBOTS_TOKEN = "WebContentResearchCrawler";
export const USER_AGENT = `${ROBOTS_TOKEN}/1.0 (non-commercial research crawler; honors robots.txt; one request at a time per host)`;
export const HOST_DELAY_MS = 1500;
export const FETCH_TIMEOUT_MS = 20_000;
export const NAV_TIMEOUT_MS = 30_000;
export const MAX_SERVER_HTML_BYTES = 3_000_000;

/** Sources (metadata/URL lists only). */
export const WCXB_REPO = "murrough-foley/web-content-extraction-benchmark";
export const WCXB_BASE = `https://huggingface.co/datasets/${WCXB_REPO}/resolve/main`;
export const WMB_REPO = "opendatalab/WebMainBench";
// The complete file (7,809 pages, ~1.35 GB) embeds the HTML: it is only streamed, never stored (attempt 2). Cap of the stream: 2 GB.
export const WMB_FULL_URL = `https://huggingface.co/datasets/${WMB_REPO}/resolve/main/webmainbench.jsonl`;
export const WMB_BYTES_LIMIT = 2 * 1024 * 1024 * 1024;

/** The main checkout's gitignored data dir: shared and persistent across worktrees (D12). */
export const DEFAULT_DATA_DIR = join("/home/ubuntu/files/PRIX/gran-prix", "data", "corpus", "frame-v0");
