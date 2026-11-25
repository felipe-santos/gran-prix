// Polite HTTP: a research user agent, robots.txt (RFC 9309), one request at a time per host with a minimum delay.
import robotsParser from "robots-parser";
import { FETCH_TIMEOUT_MS, HOST_DELAY_MS, MAX_SERVER_HTML_BYTES, ROBOTS_TOKEN, USER_AGENT } from "./config.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class PoliteHttp {
  constructor({ hostDelayMs = HOST_DELAY_MS, userAgent = USER_AGENT, fetchImpl = fetch } = {}) {
    this.hostDelayMs = hostDelayMs;
    this.userAgent = userAgent;
    this.fetchImpl = fetchImpl;
    this.tail = new Map(); // host -> promise of the last queued request
    this.lastAt = new Map(); // host -> time of the last request start
    this.robots = new Map(); // origin -> Promise<{state, parser}>
  }

  /** Runs `fn` after every earlier request to the same host finished and `hostDelayMs` elapsed. Hosts run in parallel. */
  schedule(host, fn) {
    const prev = this.tail.get(host) ?? Promise.resolve();
    const run = prev.then(async () => {
      const wait = (this.lastAt.get(host) ?? 0) + this.hostDelayMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastAt.set(host, Date.now());
      return fn();
    });
    this.tail.set(host, run.catch(() => {}));
    return run;
  }

  async get(url, { maxBytes = MAX_SERVER_HTML_BYTES, accept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" } = {}) {
    const host = new URL(url).host;
    return this.schedule(host, async () => {
      try {
        const res = await this.fetchImpl(url, {
          redirect: "follow",
          headers: { "user-agent": this.userAgent, accept, "accept-language": "en-US,en;q=0.8" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const chunks = [];
        let bytes = 0;
        for await (const c of res.body ?? []) {
          bytes += c.length;
          chunks.push(c);
          if (bytes >= maxBytes) break;
        }
        return { ok: true, status: res.status, finalUrl: res.url, contentType: res.headers.get("content-type") ?? "", text: Buffer.concat(chunks).toString("utf8"), truncated: bytes >= maxBytes };
      } catch (e) {
        return { ok: false, status: 0, error: String(e?.cause?.code ?? e?.name ?? e).slice(0, 120), message: String(e?.message ?? e).slice(0, 200) };
      }
    });
  }

  /**
   * robots.txt of an origin, cached. 2xx: parsed. 4xx: no restrictions. 5xx or unreachable: complete disallow
   * (RFC 9309 §2.3.1.4), reported as `unavailable` so it stays distinguishable from an explicit Disallow.
   */
  async robotsFor(origin) {
    if (!this.robots.has(origin)) {
      this.robots.set(
        origin,
        (async () => {
          const robotsUrl = `${origin}/robots.txt`;
          const r = await this.get(robotsUrl, { maxBytes: 500_000, accept: "text/plain,*/*;q=0.5" });
          if (r.ok && r.status >= 200 && r.status < 300) return { state: "ok", parser: robotsParser(robotsUrl, r.text) };
          if (r.ok && r.status >= 400 && r.status < 500) return { state: "none", parser: null };
          return { state: "unavailable", parser: null, detail: r.ok ? `HTTP ${r.status}` : r.error };
        })(),
      );
    }
    return this.robots.get(origin);
  }

  /** `{allowed, state, detail?}` for one URL under our robots token. */
  async robotsAllows(url) {
    const u = new URL(url);
    const r = await this.robotsFor(u.origin);
    if (r.state === "unavailable") return { allowed: false, state: "unavailable", detail: r.detail };
    if (r.state === "none") return { allowed: true, state: "none" };
    return { allowed: r.parser.isAllowed(url, ROBOTS_TOKEN) !== false, state: "ok" };
  }
}
