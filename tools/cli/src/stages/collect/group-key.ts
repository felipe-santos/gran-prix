import { getDomain } from "tldts";

/**
 * Registrable domain (eTLD+1) of a host, the unit of the anti-leakage split.
 *
 * Uses `tldts`: it ships the Public Suffix List (ICANN and private sections), needs no network call, has
 * no runtime dependencies beyond its own core, and is actively maintained (`psl` is stale and
 * `parse-domain` pulls a larger tree). With `privateSuffixes` (default) a host under a private suffix
 * such as `github.io` or `blogspot.com` is its own site (`alice.github.io`), because those subdomains
 * belong to unrelated authors; with it off they all collapse into `github.io`.
 *
 * IP addresses and single-label hosts (`localhost`) have no registrable domain: the host itself is returned.
 */
export function registrableDomain(host: string, privateSuffixes = true): string {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const domain = getDomain(h, { allowPrivateDomains: privateSuffixes });
  return domain ?? h;
}
