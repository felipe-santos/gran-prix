import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { UrlEntry } from "./url-list.js";
import { registrableDomain } from "./group-key.js";

/** Where to navigate and how the page is named in its snapshot. */
export interface Target {
  /** What the browser loads. */
  navUrl: string;
  local: boolean;
  /** For local files: the machine-independent name stored as `page.url`, `final_url` and `url_key`. */
  logicalUrl?: string;
  /** Local files only: the group when the entry gives none (the file stem). */
  stemGroup?: string;
}

/** `file:///<posix path relative to base>`: stable across machines, unlike the absolute file URL. */
function logicalFileUrl(rel: string): string {
  return `file:///${rel.split(sep).map(encodeURIComponent).join("/")}`;
}

function localTarget(absPath: string, baseDir: string): Target {
  const rel = relative(baseDir, absPath);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  const navUrl = pathToFileURL(absPath).href;
  return {
    navUrl,
    local: true,
    logicalUrl: inside ? logicalFileUrl(rel) : navUrl,
    stemGroup: basename(absPath, extname(absPath)),
  };
}

/**
 * Resolves one UrlList entry:
 *  - `http(s)://...`: loaded as is;
 *  - `file:///abs/page.html`, or a plain path (absolute or relative to `baseDir`): a local file. When it lies
 *    inside `baseDir` the snapshot records the root-relative `file:///rel/path.html`, so snapshot ids do not
 *    depend on where the repository is checked out. Outside `baseDir` the absolute file URL is kept.
 * Any other scheme (`data:`, `javascript:`, `chrome:`, ...) is refused.
 */
export function resolveTarget(entry: UrlEntry, baseDir: string): Target {
  const raw = entry.url;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") {
    new URL(raw); // throws on a malformed URL
    return { navUrl: raw, local: false };
  }
  if (scheme === "file") return localTarget(resolve(fileURLToPath(raw)), baseDir);
  if (scheme !== undefined && !/^[a-z]:[\\/]/i.test(raw)) throw new Error(`unsupported URL scheme "${scheme}:" (use http(s), file: or a relative path)`);
  return localTarget(resolve(baseDir, raw), baseDir);
}

/** Group of a page: the entry's explicit `group_key`, else the file stem (local) or the eTLD+1 of the FINAL host (http). */
export function groupKeyOf(entry: UrlEntry, target: Target, finalUrl: string, privateSuffixes: boolean): string {
  if (entry.group_key !== undefined) return entry.group_key;
  if (target.local) return target.stemGroup ?? "local";
  return registrableDomain(new URL(finalUrl).hostname, privateSuffixes);
}
