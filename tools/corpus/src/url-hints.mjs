// Review-page aids: does the final URL differ from the requested one, and does it look like an error, a home page,
// a login, an anti-bot challenge or another site? Hints are NOT decisions: the owner decides, the script only points.
import { etld1 } from "./hash.mjs";

/** Host without `www.` and path without the trailing `/` (scheme, query and fragment are ignored). `null` if not a URL. */
export function normalizeUrl(u) {
  let p;
  try {
    p = new URL(u);
  } catch {
    return null;
  }
  return { host: p.hostname.toLowerCase().replace(/^www\./, ""), path: p.pathname.replace(/\/+$/, "") };
}

/** The seal: the host or the path changed (same normalisation as the owner's review). */
export function urlChanged(requested, final) {
  const a = normalizeUrl(requested);
  const b = normalizeUrl(final);
  if (!a || !b) return false;
  return a.host !== b.host || a.path !== b.path;
}

const B = "(?:^|[^a-z0-9])";
const E = "(?:[^a-z0-9]|$)";
const PATTERNS = [
  ["erro", "possível erro / 404", new RegExp(`${B}(?:404|not[-_]?found|errors?)${E}`, "i")],
  ["login", "login / OAuth", new RegExp(`${B}(?:log[-_]?in|sign[-_]?in|oauth2?|authorize)${E}|/password(?:[/?#]|$)`, "i")],
  ["desafio", "desafio anti-bot", new RegExp(`${B}(?:challenge|captcha|anubis)${E}|cf[_-]chl`, "i")],
];

function subject(u) {
  try {
    const p = new URL(u);
    let s = `${p.hostname}${p.pathname}${p.search}`;
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep the raw form */
    }
    return s;
  } catch {
    return "";
  }
}

/**
 * Hints from the final URL, `[{kind, label}]`. A token counts only when it is NEW in the final URL (a page that was requested
 * as `/docs/oauth` is not suspicious for having `oauth` in its URL; the hint is about where the navigation went).
 */
export function urlHints(requested, final) {
  const a = normalizeUrl(requested);
  const b = normalizeUrl(final);
  if (!a || !b) return [];
  const out = [];
  const reqS = subject(requested);
  const finS = subject(final);
  for (const [kind, label, re] of PATTERNS) if (re.test(finS) && !re.test(reqS)) out.push({ kind, label });
  if (b.path === "" && a.path !== "") out.push({ kind: "home", label: "foi para a home" });
  const ea = etld1(requested);
  const eb = etld1(final);
  if (ea && eb && ea !== eb) out.push({ kind: "outro-site", label: `outro site (${eb})` });
  return out;
}

/** Final URL of an accepted record (null when unknown). */
export const finalUrlOf = (r) => r.detail?.final_url ?? r.set_entry?.final_url ?? null;
