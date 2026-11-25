// The sampler/collector (§2.2, §2.3): per category, walk the frame in `order_hash` order, apply the inclusion rules by
// script, collect accepted pages with the pipeline's own capture code and stop at the target n. Resumable.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CATEGORIES, LOCALE, NAV_TIMEOUT_MS, USER_AGENT, VIEWPORT } from "./config.mjs";
import { byOrderHash, etld1 } from "./hash.mjs";
import { PoliteHttp } from "./http.mjs";
import { appendJsonl, readJsonlSync } from "./jsonl.mjs";
import { evaluatePage, serverVisibleChars } from "./rules.mjs";
import { WalkState, targetOf } from "./state.mjs";
import { writeOutputs } from "./report.mjs";

const PAGE_TIMEOUT_MS = 110_000;
const RELAUNCH_EVERY = 40;
const PREFETCH = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The collect stage's own capture code (built `@gran-prix/cli`), so snapshots are exactly the pipeline's format. */
async function loadCollectLib() {
  const dir = new URL("../../cli/dist/stages/collect/", import.meta.url);
  const modulePath = (f) => new URL(f, dir).href;
  if (!existsSync(new URL("capture.js", dir))) throw new Error("tools/cli is not built: run `pnpm --filter @gran-prix/cli build` (and the packages it depends on) first");
  const [{ capturePage, CaptureError }, { resolveTarget }, features] = await Promise.all([
    import(modulePath("capture.js")),
    import(modulePath("target.js")),
    import("@gran-prix/features"),
  ]);
  return { capturePage, CaptureError, resolveTarget, features };
}

/** Wraps the browser so every context carries the research user agent and en-US locale, and screenshots the page before it closes. */
function wrapBrowser(browser, shotRef) {
  return {
    version: () => browser.version(),
    newContext: async (opts) => {
      const ctx = await browser.newContext({ ...opts, userAgent: USER_AGENT, locale: LOCALE });
      const close = ctx.close.bind(ctx);
      ctx.close = async (...a) => {
        const path = shotRef.path;
        const page = ctx.pages()[0];
        if (path && page && page.url() !== "about:blank") {
          try {
            await mkdir(dirname(path), { recursive: true });
            await page.screenshot({ path, type: "jpeg", quality: 55, timeout: 8000 });
            shotRef.taken = true;
          } catch {
            /* a page that cannot be screenshot is still evaluated */
          }
        }
        return close(...a);
      };
      return ctx;
    },
  };
}

class Collector {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.http = new PoliteHttp();
    this.walkedPath = join(dataDir, "walked.jsonl");
    this.setDir = join(dataDir, "snapshot-set");
    this.state = WalkState.replay(readJsonlSync(this.walkedPath));
    this.seq = Math.max(0, ...readJsonlSync(this.walkedPath).map((r) => r.seq ?? 0));
    this.shot = { path: null, taken: false };
    this.captured = 0;
  }

  async init() {
    this.lib = await loadCollectLib();
    this.bundle = this.lib.features.bundleSource();
    await this.launch();
  }

  async launch() {
    if (this.browser) await this.browser.close().catch(() => {});
    const { browser, context } = await this.lib.features.launch({ viewport: VIEWPORT });
    await context.close();
    this.browser = browser;
    this.captured = 0;
  }

  async close() {
    await this.browser?.close().catch(() => {});
  }

  /** robots.txt + (optionally) the server HTML; safe to start early because it is serialised per host. */
  async prescreen(cand, withServer) {
    let robots;
    try {
      robots = await this.http.robotsAllows(cand.url);
    } catch (e) {
      return { badUrl: String(e?.message ?? e) };
    }
    if (!robots.allowed) return { robots };
    if (!withServer) return { robots };
    const server = await this.http.get(cand.url);
    return { robots, server };
  }

  async capture(cand) {
    const { capturePage, resolveTarget, features } = this.lib;
    const entry = { url: cand.url, stratum: cand.category };
    const target = resolveTarget(entry, process.cwd());
    const wrapped = wrapBrowser(this.browser, this.shot);
    const run = capturePage(wrapped, entry, target, {
      features,
      bundle: this.bundle,
      viewport: VIEWPORT,
      quietMs: 600,
      maxMs: 8000,
      networkIdleCapMs: 3000,
      navTimeoutMs: NAV_TIMEOUT_MS,
      maxNodes: undefined,
      capturedAt: undefined,
      waitLabel: "gp-corpus dom-v0",
      privateSuffixes: true,
    });
    let timer;
    const guard = new Promise((_, rej) => {
      timer = setTimeout(() => rej(Object.assign(new Error(`page exceeded ${PAGE_TIMEOUT_MS} ms`), { reason: "timeout" })), PAGE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([run, guard]);
    } finally {
      clearTimeout(timer);
      run.catch(() => {}); // a late rejection after the timeout must not crash the run
    }
  }

  record(cand, outcome, reason, extra = {}) {
    const rec = {
      seq: ++this.seq,
      category: cand.category,
      walk_category: cand.category,
      phase: cand.phase,
      url: cand.url,
      order_hash: cand.order_hash,
      domain: cand.domain,
      source_dataset: cand.source_dataset,
      source_type: cand.source_type,
      outcome,
      reason,
      ...extra,
      at: new Date().toISOString(),
    };
    appendJsonl(this.walkedPath, rec);
    this.state.walked.add(WalkState.key(cand.category, cand.url));
    if (outcome === "accepted") this.state.accept(rec);
    return rec;
  }

  /** One candidate -> one walked record. Never throws. */
  async visit(cand, pre) {
    const cat = cand.category;
    const quota = this.state.quotaReason(cat, cand.domain);
    if (quota) return this.record(cand, "excluded", quota);

    if (pre.badUrl) return this.record(cand, "excluded", "bad-url", { detail: { error: pre.badUrl } });
    if (!pre.robots.allowed) return this.record(cand, "excluded", pre.robots.state === "unavailable" ? "robots-unavailable" : "robots-disallowed", { detail: { robots: pre.robots } });

    const detail = { robots_state: pre.robots.state };
    let serverChars;
    if (cat === "spa") {
      const s = pre.server;
      if (!s?.ok) return this.record(cand, "excluded", "navigation", { detail: { ...detail, error: s?.error, message: s?.message, via: "server-fetch" } });
      detail.server_status = s.status;
      detail.server_final_url = s.finalUrl;
      if (s.status !== 200) return this.record(cand, "excluded", `http-status-${s.status}`, { detail });
      if (!/html|xml/i.test(s.contentType)) return this.record(cand, "excluded", "not-html", { detail: { ...detail, content_type: s.contentType } });
      serverChars = serverVisibleChars(s.text);
      detail.server_chars = serverChars;
      if (serverChars >= 200) return this.record(cand, "excluded", "spa-rule:server-text>=200", { detail });
    }

    this.shot.path = join(this.dataDir, "screens", `${cat}-${cand.order_hash.slice(0, 10)}.jpg`);
    this.shot.taken = false;
    let got;
    try {
      try {
        got = await this.capture(cand);
      } catch (e) {
        // One retry for a failed navigation: ERR_NETWORK_CHANGED and connection resets are transient on this machine.
        // A dead browser is an infrastructure fault, not a property of the page: relaunch and retry once, then abort the
        // run without writing a record (a bogus exclusion would bias the walk).
        const dead = /has been closed|Target closed|browser has disconnected/i.test(String(e?.message));
        if (e?.reason !== "navigation" && !dead) throw e;
        if (dead) await this.launch();
        else await sleep(3000);
        detail[dead ? "browser_relaunched" : "navigation_retried"] = true;
        try {
          got = await this.capture(cand);
        } catch (e2) {
          if (/has been closed|Target closed|browser has disconnected/i.test(String(e2?.message))) throw new Error(`browser keeps dying on ${cand.url}: ${e2.message}`, { cause: { fatal: true } });
          throw e2;
        }
      }
    } catch (e) {
      if (e?.cause?.fatal) throw e;
      const reason = e?.reason ?? "capture";
      if (reason === "timeout") await this.launch();
      return this.record(cand, "excluded", reason === "navigation" ? "navigation" : reason, { detail: { ...detail, message: String(e?.message ?? e).slice(0, 240) }, screenshot: this.shot.taken ? this.shot.path : undefined });
    }
    if (++this.captured >= RELAUNCH_EVERY) await this.launch();

    const snap = JSON.parse(got.files[got.entry.snapshot]);
    const flags = got.entry.flags;
    const ev = evaluatePage({
      category: cat,
      requestedUrl: cand.url,
      httpStatus: got.entry.http_status,
      flags,
      nodes: snap.nodes,
      title: snap.page.title ?? "",
      htmlLang: snap.page.lang ?? null,
      ...(serverChars === undefined ? {} : { serverChars }),
    });
    const groupKey = got.entry.group_key;
    Object.assign(detail, {
      http_status: got.entry.http_status,
      final_url: got.entry.final_url,
      group_key: groupKey,
      title: (snap.page.title ?? "").slice(0, 160),
      html_lang: snap.page.lang ?? null,
      visible_chars: ev.visibleChars,
      text_elements: ev.textElements,
      node_count: got.entry.node_count,
      lang: ev.lang,
      lang_source: ev.langDecision.source,
      lang_top: ev.langDecision.top,
      flags,
    });
    const reasons = [...ev.reasons];
    if (reasons.length === 0) {
      const q = this.state.quotaReason(cat, groupKey);
      if (q) reasons.push(`${q}:final-domain`);
      const l = this.state.languageReason(cat, ev.lang);
      if (l) reasons.push(l);
    }
    const screenshot = this.shot.taken ? this.shot.path : undefined;
    if (reasons.length > 0) return this.record(cand, "excluded", reasons[0], { also: reasons.slice(1), detail, screenshot });

    for (const [rel, bytes] of Object.entries(got.files)) {
      const p = join(this.setDir, rel);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, bytes);
    }
    return this.record(cand, "accepted", "ok", { detail, set_entry: got.entry, screenshot });
  }
}

/** Candidate sequence of a category: [{phase, rows}] where later phases are only walked while the target is unmet. */
export function phasesFor(category, frame, state) {
  const own = frame.filter((r) => r.category === category).sort(byOrderHash);
  if (category !== "spa") return [{ phase: "primary", rows: own }];
  return [
    { phase: "primary", rows: own },
    // §2.3.5: the frame is exhausted for SPA (the datasets only flag them): complete with the other URLs of the frame,
    // same hash order, that are not already part of the corpus. The rendering rule (§2.1) decides.
    { phase: "spa-fallback", rows: () => frame.filter((r) => r.category !== "spa" && !state.acceptedUrls.has(r.url)).sort(byOrderHash) },
  ];
}

export async function walk(dataDir, { category, limit, spaFallback = true } = {}) {
  const frame = readJsonlSync(join(dataDir, "frame.jsonl"));
  if (frame.length === 0) throw new Error(`no frame.jsonl in ${dataDir}: run \`gp-corpus frame\` first`);
  const c = new Collector(dataDir);
  await c.init();
  let visited = 0;
  const cats = CATEGORIES.map((x) => x.name).filter((n) => category === undefined || n === category);
  try {
    for (const cat of cats) {
      const n = targetOf(cat);
      for (const ph of phasesFor(cat, frame, c.state)) {
        if (ph.phase === "spa-fallback" && !spaFallback) continue;
        if (c.state.count(cat) >= n) break;
        const rows = (typeof ph.rows === "function" ? ph.rows() : ph.rows).map((r) => ({ ...r, category: cat, phase: ph.phase, domain: r.domain ?? etld1(r.url) }));
        console.error(`[${cat}/${ph.phase}] ${c.state.count(cat)}/${n} accepted, ${rows.length} candidates in frame`);
        const pending = new Map();
        const prefetch = (i) => {
          for (let j = i; j < Math.min(rows.length, i + PREFETCH); j++) {
            const k = rows[j].url;
            if (cat !== "spa" || pending.has(k) || c.state.walked.has(WalkState.key(cat, k)) || c.state.quotaReason(cat, rows[j].domain)) continue;
            pending.set(k, c.prescreen(rows[j], true));
          }
        };
        for (let i = 0; i < rows.length && c.state.count(cat) < n; i++) {
          const cand = rows[i];
          if (c.state.walked.has(WalkState.key(cat, cand.url))) continue;
          if (limit !== undefined && visited >= limit) return;
          prefetch(i);
          const pre = c.state.quotaReason(cat, cand.domain) ? null : await (pending.get(cand.url) ?? c.prescreen(cand, cat === "spa"));
          const rec = await c.visit(cand, pre);
          visited++;
          console.error(`  #${rec.seq} ${cat} ${rec.outcome === "accepted" ? "ACCEPT" : "skip  "} ${rec.reason}  ${cand.url.slice(0, 110)}  [${c.state.count(cat)}/${n}]`);
          pending.delete(cand.url);
          await sleep(200);
        }
      }
    }
  } finally {
    await c.close();
    await writeOutputs(dataDir);
  }
}
