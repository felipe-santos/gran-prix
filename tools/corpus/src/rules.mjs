// §2.2 inclusion/exclusion rules as pure functions over a captured snapshot. No network, no browser.
import { detect } from "tinyld";
import {
  LANGS_ALLOWED,
  MAX_TEXT_ELEMENTS,
  MIN_VISIBLE_CHARS,
  SPA_RENDERED_MIN_CHARS,
  SPA_SERVER_MAX_CHARS,
} from "./config.mjs";

/**
 * Text of the elements that are rendered: a node is hidden when it, or an ancestor, has display:none or
 * visibility:hidden (the same notion as `pageFlags` of the collect stage). Nodes are in pre-order, parents first.
 * `textElements` counts every element with own text, visible or not (§2.2: "> 5.000 elementos com texto").
 */
export function textStats(nodes) {
  const hidden = [];
  const parts = [];
  let visibleChars = 0;
  let textElements = 0;
  for (const n of nodes) {
    const h = n.style.display === "none" || n.style.visibility === "hidden" || (n.parent >= 0 && hidden[n.parent] === true);
    hidden.push(h);
    if ((n.own_text_len ?? n.own_text.length) > 0) textElements++;
    if (!h && n.own_text !== "") {
      parts.push(n.own_text);
      visibleChars += n.own_text_len ?? n.own_text.length;
    }
  }
  return { visibleChars, textElements, visibleText: parts.join(" ") };
}

const DROP_BLOCKS = /<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi;
const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Characters of visible text in the HTML as served (no JavaScript executed): scripts, styles, <noscript>, templates,
 * SVG and <head> are dropped, then tags, then whitespace is collapsed. An approximation of "visible"; it ignores CSS.
 */
export function serverVisibleChars(html) {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(DROP_BLOCKS, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|apos);|&#\d+;|&#x[0-9a-f]+;/gi, (m, name) => (name ? ENTITIES[name.toLowerCase()] : " "))
    .replace(/\s+/g, " ")
    .trim();
  return text.length;
}

/** ISO 639-1 code of the visible text (tinyld; `""` when undecidable). 3000 chars are plenty and keep it fast. */
export const detectLanguage = (text) => detect(text.slice(0, 3000));

// ---- out-of-scope type, adult, personal profile / PII (heuristics, recorded with their reason) ----

const SCOPE_PATH = /(^|\/)(search|login|log-in|signin|sign-in|signup|sign-up|register|account\/login|auth|cart|checkout|feed|rss)(\/|$|\.)/i;
const SCOPE_QUERY = /[?&](s|q|query|search|keyword|keywords)=/i;
// The whole title is the login/search label (optionally followed by a site name): "Login Security Solution" is not a login page.
const SCOPE_TITLE = /^\s*(log ?in|sign ?in|sign ?up|register|search( results)?)\s*([|\-\u2013\u2014:\u00b7].*)?$/i;

/** "tipos fora do escopo (listagem, coleção, busca, índice, login)": URL and title patterns only; the WCXB type already drops listing/collection. */
export function outOfScopeType(url, title = "") {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return SCOPE_PATH.test(u.pathname) || SCOPE_QUERY.test(u.search) || SCOPE_TITLE.test(title);
}

const ADULT_HOST = /(^|[.-])(porn|xxx|xvideos|xnxx|redtube|youporn|xhamster|onlyfans|hentai|erotic|sex(cam|chat|tube)?)([.-]|$)/i;
const ADULT_TERMS = /\b(porn(o|ography)?|xxx|nude (photos|pics|videos)|hentai|escort service|sex (cam|chat|videos?)|erotic (stories|videos)|adult (video|content|only)|18\+|nsfw)\b/gi;

export function adultContent(url, title, text) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* ignore */
  }
  if (ADULT_HOST.test(host)) return true;
  const hits = `${title} ${text.slice(0, 20000)}`.match(ADULT_TERMS);
  return (hits?.length ?? 0) >= 3;
}

const PROFILE_URL = [
  /^https?:\/\/([a-z]+\.)?linkedin\.com\/(in|pub|company\/[^/]+\/people)\//i,
  /^https?:\/\/([a-z]+\.)?(facebook|instagram|tiktok|threads)\.com\/[^/?#]+\/?$/i,
  /^https?:\/\/(www\.)?(twitter|x)\.com\/[^/?#]+\/?$/i,
  /^https?:\/\/(www\.)?reddit\.com\/(user|u)\//i,
  /^https?:\/\/(www\.)?github\.com\/[^/?#]+\/?$/i,
  /^https?:\/\/[^/]+\/(user|users|profile|profiles|people|member|members)\/[^/?#]+\/?$/i,
];
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** "perfis pessoais e páginas com PII evidente": a profile URL shape, or >= 5 distinct e-mail addresses in the visible text. */
export function personalProfileOrPii(url, text) {
  if (PROFILE_URL.some((re) => re.test(url))) return "personal-profile";
  const emails = new Set((text.match(EMAIL) ?? []).map((e) => e.toLowerCase()));
  return emails.size >= 5 ? "pii-evident" : null;
}

/**
 * Evaluates one captured page against §2.2 (+ §2.1 SPA rule). Returns every failing reason in a fixed priority order;
 * the first is the recorded exclusion reason, the rest go to `also`.
 *
 * input: { category, requestedUrl, httpStatus, flags, nodes, title, serverChars (spa only) }
 */
export function evaluatePage(input) {
  const stats = textStats(input.nodes);
  const lang = stats.visibleChars > 0 ? detectLanguage(stats.visibleText) : "";
  const reasons = [];
  if (input.httpStatus !== 200) reasons.push(`http-status-${input.httpStatus}`);
  for (const f of ["http-error", "error-page", "captcha", "paywall"]) {
    if (input.flags.includes(f) && !(f === "http-error" && input.httpStatus !== 200)) reasons.push(`flag:${f}`);
  }
  if (stats.visibleChars < MIN_VISIBLE_CHARS) reasons.push("visible-chars<300");
  if (stats.textElements > MAX_TEXT_ELEMENTS) reasons.push("text-elements>5000");
  if (stats.visibleChars >= MIN_VISIBLE_CHARS && !LANGS_ALLOWED.includes(lang)) reasons.push(lang === "" ? "language-undetermined" : `language:${lang}`);
  if (outOfScopeType(input.requestedUrl, input.title)) reasons.push("out-of-scope-type");
  if (adultContent(input.requestedUrl, input.title ?? "", stats.visibleText)) reasons.push("adult-content");
  const pii = personalProfileOrPii(input.requestedUrl, stats.visibleText);
  if (pii !== null) reasons.push(pii);
  if (input.category === "spa") {
    if (input.serverChars !== undefined && input.serverChars >= SPA_SERVER_MAX_CHARS) reasons.push("spa-rule:server-text>=200");
    if (stats.visibleChars <= SPA_RENDERED_MIN_CHARS) reasons.push("spa-rule:rendered-text<=1000");
  }
  return { reasons, lang, visibleChars: stats.visibleChars, textElements: stats.textElements };
}
