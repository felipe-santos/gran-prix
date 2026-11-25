import { createHash } from "node:crypto";
import { getDomain, getHostname } from "tldts";
import { ORDER_PREFIX } from "./config.mjs";

/** §2.3.2: `sha256("gp-dom-v0|20261125|" + url)` as lowercase hex; candidates are walked in ascending order. */
export const orderHash = (url) => createHash("sha256").update(ORDER_PREFIX + url, "utf8").digest("hex");

/** eTLD+1 from the Public Suffix List INCLUDING the private section (`alice.github.io` is its own site). */
export function etld1(urlOrHost) {
  const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(urlOrHost) ? getHostname(urlOrHost, { allowPrivateDomains: true }) : urlOrHost;
  if (!host) return null;
  return getDomain(host.toLowerCase(), { allowPrivateDomains: true }) ?? host.toLowerCase();
}

/** Total order of the walk: hash, then url (a tie is astronomically unlikely, but the order must be total). */
export const byOrderHash = (a, b) => (a.order_hash < b.order_hash ? -1 : a.order_hash > b.order_hash ? 1 : a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
