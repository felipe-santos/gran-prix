// §2.2 inclusion/exclusion rules as pure functions over a captured snapshot. No network, no browser.
import { detectAll } from "tinyld";
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
  const sentences = [];
  let visibleChars = 0;
  let textElements = 0;
  for (const n of nodes) {
    const h = n.style.display === "none" || n.style.visibility === "hidden" || (n.parent >= 0 && hidden[n.parent] === true);
    hidden.push(h);
    if ((n.own_text_len ?? n.own_text.length) > 0) textElements++;
    if (!h && n.own_text !== "") {
      parts.push(n.own_text);
      if (n.own_text.length >= LANG_UNIT_MIN_CHARS) sentences.push(n.own_text);
      visibleChars += n.own_text_len ?? n.own_text.length;
    }
  }
  return { visibleChars, textElements, visibleText: parts.join(" "), sentences };
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

// ---- language (attempt 2 implementation; the protocol rule "en >= 70%, pt/es <= 30%, others excluded" is unchanged) ----

export const LANG_UNIT_MIN_CHARS = 40;
export const LANG_SAMPLE_MAX_CHARS = 5000;
export const LANG_SAMPLE_MIN_CHARS = 300;
const LANG_TOP = 3;

/**
 * (a) The text the detector sees: the visible text units of at least 40 characters (sentences, not menus or short code),
 * concatenated up to 5,000 characters; when fewer than 300 remain, all the visible text.
 */
export function languageSample(sentences, visibleText) {
  let sample = "";
  for (const s of sentences) {
    if (sample.length >= LANG_SAMPLE_MAX_CHARS) break;
    sample += (sample === "" ? "" : " ") + s;
  }
  sample = sample.slice(0, LANG_SAMPLE_MAX_CHARS);
  return sample.length >= LANG_SAMPLE_MIN_CHARS ? sample : visibleText.slice(0, LANG_SAMPLE_MAX_CHARS);
}

/** (b) The primary subtag of `<html lang>` (`en-US` -> `en`) when it is a well-formed two-letter code, else null. */
export function htmlLangPrimary(htmlLang) {
  const m = /^([a-z]{2})(?:[-_][a-z0-9]+)*$/i.exec((htmlLang ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * (c)+(d) `tinyld` `detectAll` ranks the languages of the sample. If `<html lang>` (L_h) exists and is among the detector's
 * top 3, or the detector does not decide, the language is L_h; otherwise it is the detector's first choice. Short technical
 * text makes the detector's first choice unreliable (English API docs came out as tl, el, cs); the page's own declaration
 * breaks the tie only when the detector also finds it plausible. Returns `{lang, source, htmlLang, top}`; `lang` is "" when
 * nothing decides.
 */
export function decideLanguage(sample, htmlLang) {
  const lh = htmlLangPrimary(htmlLang);
  const top = sample.trim() === "" ? [] : detectAll(sample).slice(0, LANG_TOP).map((d) => d.lang);
  if (lh !== null && top.includes(lh)) return { lang: lh, source: "html-lang(in-top3)", htmlLang: lh, top };
  if (lh !== null && top.length === 0) return { lang: lh, source: "html-lang(detector-undecided)", htmlLang: lh, top };
  if (top.length > 0) return { lang: top[0], source: "detector", htmlLang: lh, top };
  return { lang: "", source: "none", htmlLang: lh, top };
}

// ---- out-of-scope type, adult, personal profile / PII (heuristics, recorded with their reason) ----

// Only a page whose PATH IS the search / login / registration / feed endpoint (optionally under a locale prefix such as /en/ or
// /pt-br/): a documentation page about authentication (/docs/guides/auth) or about search is content, not a login page.
const SCOPE_PATH = /^\/(?:[a-z]{2}(?:[-_][a-z]{2})?\/)?(?:search|login|log-in|signin|sign-in|signup|sign-up|register|cart|checkout|feed|rss)(?:\.[a-z]+)?\/?$/i;
// `?s=` is WordPress search, but Twitter/X share links carry `?s=20`: only a non-numeric value counts.
const SCOPE_QUERY = /[?&](?:s=[^&\d][^&]*|q=[^&]+|query=[^&]+|search=[^&]+|keywords?=[^&]+)/i;
// The whole title is the login/search label (optionally followed by a site name): "Login Security Solution" is not a login page.
const SCOPE_TITLE = /^\s*(log ?in|sign ?in|sign ?up|register|search( results)?)\s*([|\-–—:·].*)?$/i;

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
// Terms that name adult content by themselves. Ambiguous tokens need their context:
//  - "18+" is also "Java 18+", "Node 18+", "iOS 18+": only with an age context (18+ only, adults only, must be 18, over 18);
//  - "xxx" is also a placeholder ("Bearer xxx", "xxx-xxxx", "sk_xxx"): only when it names a kind of content ("xxx videos").
const ADULT_TERMS = [
  /\bporn(?:o|ography)?\b/gi,
  /\bhentai\b/gi,
  /\bescort service\b/gi,
  /\bnude (?:photos|pics|videos)\b/gi,
  /\bsex (?:cams?|chat|videos?)\b/gi,
  /\berotic (?:stories|videos)\b/gi,
  /\badult (?:video|content|only)\b/gi,
  /\bnsfw\b/gi,
  /(?<![\w.-])xxx (?:videos?|movies?|porn|sex|rated|content|pics|photos|cams?)(?![\w-])/gi,
  /\b18\+ (?:only|adults?|content|site|website|audience)\b/gi,
  /\bmust be (?:at least )?18(?:\+| years)?(?![\w.])/gi,
  /\badults only\b/gi,
  /\bover 18(?: years)? (?:only|to enter)\b/gi,
];

export function adultContent(url, title, text) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* ignore */
  }
  if (ADULT_HOST.test(host)) return true;
  const hay = `${title} ${text.slice(0, 20000)}`;
  let hits = 0;
  for (const re of ADULT_TERMS) hits += (hay.match(re) ?? []).length;
  return hits >= 3;
}

// First path segments of big platforms that are product / marketing pages, not people ("github.com/features", "x.com/i").
const RESERVED_FIRST = new Set([
  "about", "account", "apps", "business", "careers", "collections", "company", "contact", "customer-stories", "download", "downloads",
  "enterprise", "events", "explore", "features", "help", "home", "i", "jobs", "legal", "login", "logout", "marketplace", "new", "news",
  "notifications", "organizations", "orgs", "pages", "premium", "pricing", "privacy", "readme", "resources", "search", "security",
  "settings", "share", "signup", "solutions", "sponsors", "stories", "support", "team", "teams", "terms", "topics", "tos", "trending", "watch",
]);
const PLATFORM_ONE_SEGMENT = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:facebook|instagram|tiktok|threads|twitter|x|github|gitlab|medium)\.(?:com|net)\/([^/?#]+)\/?$/i;
const PROFILE_URL = [
  /^https?:\/\/(?:[a-z]+\.)?linkedin\.com\/(?:in|pub)\//i,
  /^https?:\/\/(?:www\.)?reddit\.com\/(?:user|u)\//i,
  /^https?:\/\/[^/]+\/(?:user|users|profile|profiles)\/[^/?#]+\/?$/i, // "/people/" and "/members/" alone are sections, not profiles
  /^https?:\/\/[^/]+\/members?\/[^/?#]+\.\d+\/?$/i, // XenForo member pages: /members/jane.1234/
];
const EMAIL = /[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/gi;
const PLACEHOLDER_MAIL_DOMAIN = /^(?:example\.(?:com|org|net)|(?:.+\.)?(?:test|invalid|localhost|example)|domain\.com|yourdomain\.com|yourcompany\.com|email\.com)$/i;

/**
 * "perfis pessoais e páginas com PII evidente": a profile URL shape, or >= 5 distinct real-looking e-mail addresses in the
 * visible text (RFC 2606 example domains and common placeholders do not count: API docs are full of user@example.com).
 */
export function personalProfileOrPii(url, text) {
  if (PROFILE_URL.some((re) => re.test(url))) return "personal-profile";
  const one = PLATFORM_ONE_SEGMENT.exec(url);
  if (one && !RESERVED_FIRST.has((one[1] ?? "").toLowerCase())) return "personal-profile";
  const emails = new Set();
  for (const m of text.matchAll(EMAIL)) if (!PLACEHOLDER_MAIL_DOMAIN.test(m[1] ?? "")) emails.add(m[0].toLowerCase());
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
  const langDecision = stats.visibleChars > 0 ? decideLanguage(languageSample(stats.sentences, stats.visibleText), input.htmlLang) : { lang: "", source: "none", htmlLang: null, top: [] };
  const lang = langDecision.lang;
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
  return { reasons, lang, langDecision, visibleChars: stats.visibleChars, textElements: stats.textElements };
}
