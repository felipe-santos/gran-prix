import type { ArtifactHandle } from "../../store.js";

/** One row of a `UrlList`: what to collect, which stratum it stands for and (optionally) its split group. */
export interface UrlEntry {
  /** `https://...`, `file:///abs/path.html` or a plain path relative to the collection base directory. */
  url: string;
  /** Category of the page (article, product, ...); becomes `page.category`. */
  stratum: string;
  /** Explicit anti-leakage group; default = registrable domain (http) or file stem (local files). */
  group_key?: string;
}

const decoder = new TextDecoder();

/** Splits one CSV record (RFC 4180 quotes; no multi-line fields, URLs never contain newlines). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function fromRows(rows: unknown[], where: string): UrlEntry[] {
  const out: UrlEntry[] = [];
  rows.forEach((row, i) => {
    const at = `${where}[${i}]`;
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error(`UrlList ${at}: expected an object {url, stratum, group_key?}`);
    const r = row as Record<string, unknown>;
    const url = r["url"];
    const stratum = r["stratum"] ?? r["category"];
    const group = r["group_key"];
    if (typeof url !== "string" || url.trim() === "") throw new Error(`UrlList ${at}: "url" must be a non-empty string`);
    if (typeof stratum !== "string" || stratum.trim() === "") throw new Error(`UrlList ${at} (${url}): "stratum" must be a non-empty string`);
    if (group !== undefined && group !== null && group !== "" && typeof group !== "string") throw new Error(`UrlList ${at} (${url}): "group_key" must be a string`);
    out.push({ url: url.trim(), stratum: stratum.trim(), ...(typeof group === "string" && group.trim() !== "" ? { group_key: group.trim() } : {}) });
  });
  return out;
}

/**
 * Parses a `UrlList` artifact. Accepted forms:
 *  - JSON: an array of `{url, stratum, group_key?}` or `{ "urls": [...] }`;
 *  - CSV (any file that is not `.json`): header line `url,stratum[,group_key]`, one row per page.
 * Duplicate URLs are an error: a repeated page would only inflate a split group.
 */
export function parseUrlList(handle: Pick<ArtifactHandle, "json" | "file" | "files">): UrlEntry[] {
  let entries: UrlEntry[];
  const files = handle.files();
  if (files.length === 0) {
    const doc = handle.json();
    const rows = Array.isArray(doc) ? doc : doc !== null && typeof doc === "object" ? (doc as { urls?: unknown }).urls : undefined;
    if (!Array.isArray(rows)) throw new Error('UrlList JSON must be an array of {url, stratum, group_key?} or an object {"urls": [...]}');
    entries = fromRows(rows, "urls");
  } else {
    if (files.length !== 1) throw new Error(`UrlList file set must hold exactly one file, found ${files.length}`);
    const text = decoder.decode(handle.file(files[0] as string)).replace(/^﻿/, "");
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
    const header = splitCsvLine(lines[0] ?? "").map((h) => h.toLowerCase());
    const col = (name: string): number => header.indexOf(name);
    if (col("url") < 0 || (col("stratum") < 0 && col("category") < 0)) throw new Error("UrlList CSV needs a header with at least: url,stratum (or category)");
    const rows = lines.slice(1).map((l) => {
      const cells = splitCsvLine(l);
      const cell = (name: string): string | undefined => (col(name) >= 0 ? cells[col(name)] : undefined);
      return { url: cell("url"), stratum: cell("stratum") ?? cell("category"), group_key: cell("group_key") };
    });
    entries = fromRows(rows, "rows");
  }
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.url)) throw new Error(`UrlList: duplicate url ${e.url}`);
    seen.add(e.url);
  }
  if (entries.length === 0) throw new Error("UrlList is empty");
  return entries;
}
