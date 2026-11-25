// Frame builder (§2.3.1): the union of the URL lists of WCXB (CC-BY-4.0) and WebMainBench (Apache-2.0).
// Only metadata/URL lists are fetched. The page HTML of both datasets is never stored.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CATEGORIES, WCXB_BASE, WCXB_EXCLUDED_TYPES, WCXB_TYPE_TO_CATEGORY, WMB_FULL_URL, WMB_BYTES_LIMIT } from "./config.mjs";
import { byOrderHash, etld1, orderHash } from "./hash.mjs";
import { appendJsonl, readJsonl, writeJsonl } from "./jsonl.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWithRetry(url, tries = 7) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      // The timeout covers the response HEADERS only: the 1.35 GB stream of WebMainBench runs for tens of minutes.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 60_000);
      let r;
      try {
        r = await fetch(url, { redirect: "follow", signal: ctl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (r.ok) return r;
      last = new Error(`HTTP ${r.status} for ${url}`);
      if (r.status !== 429 && r.status < 500) break;
      const ra = Number(r.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 120) * 1000 : 5000 * 2 ** i);
      continue;
    } catch (e) {
      last = e;
    }
    await sleep(1000 * 2 ** i);
  }
  throw last;
}

/** WCXB: metadata.json lists id/split/page_type/domain/spa; the URL lives in each ground-truth file (only `url` is kept). */
export async function fetchWcxbIndex(dataDir, { concurrency = 3, log = console.error } = {}) {
  const rawDir = join(dataDir, "raw");
  await mkdir(rawDir, { recursive: true });
  const metaPath = join(rawDir, "wcxb-metadata.json");
  if (!existsSync(metaPath)) await writeFile(metaPath, Buffer.from(await (await getWithRetry(`${WCXB_BASE}/metadata.json`)).arrayBuffer()));
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  const ids = Object.keys(meta.files).sort();
  const indexPath = join(rawDir, "wcxb-index.jsonl");
  const have = new Map((await readJsonl(indexPath)).map((r) => [r.file_id, r]));
  const todo = ids.filter((id) => !have.has(id));
  log(`wcxb: ${ids.length} files in metadata.json, ${have.size} cached, ${todo.length} to fetch`);
  let next = 0;
  let bytes = 0;
  const worker = async () => {
    while (next < todo.length) {
      const id = todo[next++];
      const m = meta.files[id];
      const res = await getWithRetry(`${WCXB_BASE}/${m.split}/ground-truth/${id}.json`);
      const buf = Buffer.from(await res.arrayBuffer());
      bytes += buf.length;
      const gt = JSON.parse(buf.toString("utf8"));
      const row = {
        file_id: id,
        split: m.split,
        page_type: m.page_type,
        gt_page_type: gt?._internal?.page_type?.primary ?? null,
        spa: m.spa === true,
        domain: m.domain,
        url: gt.url,
      };
      have.set(id, row);
      appendJsonl(indexPath, row); // resumable: a 429 storm or a crash keeps everything fetched so far
      if (have.size % 250 === 0) log(`wcxb: ${have.size}/${ids.length} (${(bytes / 1e6).toFixed(1)} MB downloaded this run)`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const rows = ids.map((id) => have.get(id));
  await writeJsonl(indexPath, rows);
  log(`wcxb: index complete, ${rows.length} rows, ${(bytes / 1e6).toFixed(1)} MB downloaded this run`);
  return { rows, downloadedBytes: bytes };
}

const JSONLD_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** `@type` values found in the JSON-LD blocks of an HTML string (flat; `@graph` is followed one level). */
export function jsonLdTypes(html) {
  const out = new Set();
  const visit = (node, depth) => {
    if (depth > 4 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
    const t = node["@type"];
    for (const x of Array.isArray(t) ? t : t ? [t] : []) if (typeof x === "string") out.add(x);
    if (node["@graph"]) visit(node["@graph"], depth + 1);
  };
  for (const m of html.matchAll(JSONLD_RE)) {
    try {
      visit(JSON.parse(m[1]), 0);
    } catch {
      /* malformed JSON-LD is ignored */
    }
  }
  return [...out];
}

/**
 * WebMainBench: the full jsonl (7,809 pages, ~1.35 GB) embeds the HTML. It is streamed line by line and only
 * track_id / url / language / JSON-LD types are kept (the HTML is never stored); the stream is aborted past the 2 GB cap.
 */
export async function fetchWmbIndex(dataDir, { log = console.error } = {}) {
  const rawDir = join(dataDir, "raw");
  await mkdir(rawDir, { recursive: true });
  const indexPath = join(rawDir, "wmb-full-index.jsonl");
  const cached = await readJsonl(indexPath);
  if (cached.length > 0) {
    log(`wmb: index cached (${cached.length} rows)`);
    return { rows: cached, downloadedBytes: 0 };
  }
  const res = await getWithRetry(WMB_FULL_URL);
  const rows = [];
  let bytes = 0;
  let buf = "";
  const dec = new TextDecoder();
  const take = (line) => {
    if (line.trim() === "") return;
    const d = JSON.parse(line);
    rows.push({
      track_id: d.track_id,
      url: d.url,
      language: d.meta?.language ?? null,
      jsonld_types: typeof d.html === "string" ? jsonLdTypes(d.html) : [],
    });
  };
  for await (const chunk of res.body) {
    bytes += chunk.length;
    if (bytes > WMB_BYTES_LIMIT) throw new Error(`wmb: download exceeded ${WMB_BYTES_LIMIT} bytes, aborting`);
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      take(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  take(buf + dec.decode());
  await writeJsonl(indexPath, rows);
  log(`wmb: ${rows.length} rows, ${(bytes / 1e6).toFixed(1)} MB streamed (not stored)`);
  return { rows, downloadedBytes: bytes };
}

const ARTICLE_LD = /^(Article|NewsArticle|BlogPosting|ScholarlyArticle|Report|OpinionNewsArticle|AnalysisNewsArticle|ReportageNewsArticle)$/;
const FORUM_LD = /^(DiscussionForumPosting|QAPage|Question)$/;

/**
 * WebMainBench has no page-type field usable here, so the protocol's "regra de URL/JSON-LD" is applied.
 * JSON-LD first (Product > forum types > TechArticle > Article), then URL path patterns. Unclassified rows stay out of the frame.
 */
export function classifyWmb(row) {
  const types = row.jsonld_types ?? [];
  if (types.includes("Product")) return "product";
  if (types.some((t) => FORUM_LD.test(t))) return "forum";
  if (types.includes("TechArticle") || types.includes("APIReference")) return "docs";
  let u;
  try {
    u = new URL(row.url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  if (/^(docs|developer|developers|documentation|learn)\./.test(host) || /\.readthedocs\.(io|org)$/.test(host) || /(^|\/)(docs|documentation|api-reference|reference|manual)(\/|$)/.test(path)) return "docs";
  if (/(^|\/)(forum|forums|thread|threads|topic|topics|discussion|questions|community)(\/|$)/.test(path) || /^(forum|forums|community|discuss)\./.test(host)) return "forum";
  if (/(^|\/)(product|products|dp|item|p)\/[^/]+/.test(path)) return "product";
  if (types.some((t) => ARTICLE_LD.test(t))) return "article";
  return null;
}

/**
 * Frame rows `{url, source_dataset, source_type, category, order_hash, ...}`. WCXB first (the primary list), WebMainBench
 * only adds URLs that WCXB does not have. Listing/collection are dropped; WCXB pages flagged SPA go to `spa`.
 * Returns the sorted rows plus counts of what was dropped.
 */
export function buildFrame(wcxbRows, wmbRows) {
  const byUrl = new Map();
  const stats = { wcxb_total: wcxbRows.length, wcxb_dropped_type: {}, wcxb_duplicate_url: 0, wcxb_missing_url: 0, wmb_total: wmbRows.length, wmb_unclassified: 0, wmb_already_in_wcxb: 0, wmb_added: 0 };
  for (const r of wcxbRows) {
    if (WCXB_EXCLUDED_TYPES.includes(r.page_type)) {
      stats.wcxb_dropped_type[r.page_type] = (stats.wcxb_dropped_type[r.page_type] ?? 0) + 1;
      continue;
    }
    const typed = WCXB_TYPE_TO_CATEGORY[r.page_type];
    if (typed === undefined) continue;
    if (typeof r.url !== "string" || r.url === "") {
      stats.wcxb_missing_url++;
      continue;
    }
    if (byUrl.has(r.url)) {
      stats.wcxb_duplicate_url++;
      continue;
    }
    byUrl.set(r.url, {
      url: r.url,
      source_dataset: "wcxb",
      source_type: r.page_type,
      category: r.spa ? "spa" : typed,
      order_hash: orderHash(r.url),
      source_id: r.file_id,
      spa_flag: r.spa === true,
    });
  }
  for (const r of wmbRows) {
    if (typeof r.url !== "string" || r.url === "") continue;
    if (byUrl.has(r.url)) {
      stats.wmb_already_in_wcxb++;
      continue;
    }
    const category = classifyWmb(r);
    if (category === null) {
      stats.wmb_unclassified++;
      continue;
    }
    stats.wmb_added++;
    byUrl.set(r.url, { url: r.url, source_dataset: "webmainbench", source_type: (r.jsonld_types ?? []).join(",") || "url-rule", category, order_hash: orderHash(r.url), source_id: r.track_id, spa_flag: false });
  }
  const rows = [...byUrl.values()].map((r) => ({ ...r, domain: etld1(r.url) })).sort(byOrderHash);
  const per = Object.fromEntries(CATEGORIES.map((c) => [c.name, rows.filter((r) => r.category === c.name).length]));
  return { rows, stats: { ...stats, frame_rows: rows.length, per_category: per } };
}

export async function writeFrame(dataDir, rows, stats) {
  await writeJsonl(join(dataDir, "frame.jsonl"), rows);
  await writeFile(join(dataDir, "frame-stats.json"), `${JSON.stringify(stats, null, 2)}\n`);
}

