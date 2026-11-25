// collect on live-ish pages (a local HTTP server): flags, failures, redirects, group keys; plus unit tests of the helpers.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validate, type PipelineSpec, type Sha256 } from "@gran-prix/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore, dataPaths, runPipeline, type RunSummary } from "../src/index.js";
import { SnapshotSetReader } from "../src/stages/collect-stages.js";
import { pageFlags } from "../src/stages/collect/flags.js";
import { registrableDomain } from "../src/stages/collect/group-key.js";
import { resolveTarget } from "../src/stages/collect/target.js";
import { parseUrlList, splitCsvLine } from "../src/stages/collect/url-list.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

const para = (n: number): string => `<p>${"Plain invented sentence about nothing in particular. ".repeat(n)}</p>`;
const page = (title: string, body: string): string => `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;

const ROUTES: Record<string, { status?: number; headers?: Record<string, string>; body?: string }> = {
  "/ok": { body: page("An ordinary page", `<main><h1>Heading</h1>${para(12)}</main>`) },
  "/missing": { status: 404, body: page("Not here", `<h1>Error 404</h1><p>The thing you asked for is gone.</p>`) },
  "/challenge": { body: page("Just a moment...", `<p>Checking your browser before accessing the site. Please verify you are human.</p>`) },
  "/wall": { body: page("Story", `<article><h1>Story</h1><p>Subscribe to continue reading this story.</p></article>`) },
  "/hop": { status: 302, headers: { location: "/ok" } },
  "/big": { body: page("Big", `<main>${"<div>x</div>".repeat(150)}</main>`) },
};

let server: Server;
let base: string;
/** An origin where nothing listens (a port that was open a moment ago; Chromium blocks low "unsafe" ports). */
let dead: string;

beforeAll(async () => {
  const probe = createServer();
  await new Promise<void>((ok) => probe.listen(0, "127.0.0.1", ok));
  dead = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
  await new Promise<void>((ok) => probe.close(() => ok()));
  server = createServer((req, res) => {
    const r = ROUTES[req.url ?? ""];
    if (!r) {
      res.writeHead(500).end();
      return;
    }
    res.writeHead(r.status ?? 200, { "content-type": "text/html; charset=utf-8", ...r.headers });
    res.end(r.body ?? "");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

function collectSpec(urls: string, params: Record<string, unknown> = {}): PipelineSpec {
  return {
    format: "gran-prix.pipeline-spec",
    format_version: "1.0.0",
    name: "collect-only",
    externals: { urls: { type: "UrlList", path: urls } },
    stages: [
      {
        id: "collect",
        kind: "collect",
        impl: "ts:collect.playwright@1.0.0",
        params: { viewport: [900, 700], settle: { quiet_ms: 200, max_ms: 2000, network_idle_cap_ms: 500 }, max_nodes: 100, ...params },
        inputs: { urls: { external: "urls" } },
      },
    ],
  };
}

async function runCollect(entries: unknown[], params: Record<string, unknown> = {}): Promise<{ run: RunSummary; set?: SnapshotSetReader; dataDir: string }> {
  const dir = tmpDir("gp-collect-pages-");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "urls.json"), JSON.stringify(entries));
  const dataDir = join(dir, "data");
  const run = await runPipeline(collectSpec(join(dir, "urls.json"), params), { dataDir });
  const id = run.stages[0]?.outputs["snapshots"];
  const set = typeof id === "string" ? new SnapshotSetReader(new ArtifactStore(dataPaths(dataDir).artifacts).handle(id as Sha256, "SnapshotSet")) : undefined;
  return { run, ...(set ? { set } : {}), dataDir };
}

describe("collect: http pages", () => {
  it("flags error, captcha, paywall and tiny pages instead of dropping them; follows redirects", async () => {
    const { run, set } = await runCollect([
      { url: `${base}/ok`, stratum: "article" },
      { url: `${base}/missing`, stratum: "article" },
      { url: `${base}/challenge`, stratum: "article" },
      { url: `${base}/wall`, stratum: "article" },
      { url: `${base}/hop`, stratum: "article", group_key: "explicit-group" },
    ]);
    expect(run.ok, JSON.stringify(run.stages.map((s) => s.error))).toBe(true);
    const by = Object.fromEntries((set as SnapshotSetReader).entries().map((e) => [e.url.replace(base, ""), e]));
    expect(Object.keys(by)).toEqual(["/ok", "/missing", "/challenge", "/wall", "/hop"]);

    expect(by["/ok"]?.flags).toEqual(["tiny-dom"]); // a handful of elements, ~650 characters
    expect(by["/ok"]?.http_status).toBe(200);
    expect(by["/missing"]?.http_status).toBe(404);
    expect(by["/missing"]?.flags).toEqual(expect.arrayContaining(["http-error", "tiny-dom"]));
    expect(by["/challenge"]?.flags).toContain("captcha");
    expect(by["/wall"]?.flags).toContain("paywall");

    // redirect: url = requested, final_url = where it landed, explicit group_key wins
    expect(by["/hop"]?.final_url).toBe(`${base}/ok`);
    expect(by["/hop"]?.group_key).toBe("explicit-group");
    // an IP host has no registrable domain: the host itself is the group
    expect(by["/ok"]?.group_key).toBe("127.0.0.1");

    for (const e of (set as SnapshotSetReader).entries()) {
      const snap = (set as SnapshotSetReader).snapshot(e);
      expect(validate("page-snapshot", snap).issues, e.url).toEqual([]);
      expect((snap.capture as { flags?: string[] }).flags).toEqual(e.flags);
      expect(snap.page.url_key).not.toContain("#");
    }
  });

  it("lists pages that cannot be snapshotted in manifest.failures; the rest of the set is intact", async () => {
    const { run, set } = await runCollect([
      { url: `${base}/ok`, stratum: "article" },
      { url: `${dead}/unreachable`, stratum: "article" },
      { url: `${base}/big`, stratum: "article" },
      { url: "javascript:alert(1)", stratum: "article" },
    ]);
    expect(run.ok).toBe(true);
    const m = (set as SnapshotSetReader).manifest();
    expect(m.entries.map((e) => e.url)).toEqual([`${base}/ok`]);
    expect(m.failures.map((f) => [f.url.replace(base, ""), f.reason])).toEqual([
      [`${dead}/unreachable`, "navigation"],
      ["/big", "max_nodes"],
      ["javascript:alert(1)", "bad_url"],
    ]);
    expect(m.failures[0]?.message).toMatch(/ERR_CONNECTION_REFUSED/);
  });

  it("fail_on_error turns any failure into a failed stage; zero snapshots always fails", async () => {
    const strict = await runCollect(
      [
        { url: `${base}/ok`, stratum: "article" },
        { url: `${dead}/x`, stratum: "article" },
      ],
      { fail_on_error: true },
    );
    expect(strict.run.ok).toBe(false);
    expect(strict.run.stages[0]?.error).toMatch(/1 of 2 page\(s\) failed/);

    const none = await runCollect([{ url: `${dead}/x`, stratum: "article" }]);
    expect(none.run.ok).toBe(false);
    expect(none.run.stages[0]?.error).toMatch(/no page could be snapshotted/);
  });
});

describe("helpers", () => {
  it("registrableDomain: eTLD+1 via the public suffix list", () => {
    expect(registrableDomain("www.example.com")).toBe("example.com");
    expect(registrableDomain("a.b.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("EXAMPLE.org")).toBe("example.org");
    expect(registrableDomain("news.example.com.br")).toBe("example.com.br");
    expect(registrableDomain("alice.github.io")).toBe("alice.github.io"); // private suffix: its own site
    expect(registrableDomain("alice.github.io", false)).toBe("github.io");
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
    expect(registrableDomain("localhost")).toBe("localhost");
    expect(registrableDomain("[::1]")).toBe("::1");
  });

  it("resolveTarget: relative paths and file URLs inside the base become machine-independent names", () => {
    const t = resolveTarget({ url: "fixtures/pages/a b.html", stratum: "x" }, "/repo");
    expect(t).toMatchObject({ local: true, navUrl: "file:///repo/fixtures/pages/a%20b.html", logicalUrl: "file:///fixtures/pages/a%20b.html", stemGroup: "a b" });
    expect(resolveTarget({ url: "file:///repo/x/p.html", stratum: "x" }, "/repo").logicalUrl).toBe("file:///x/p.html");
    expect(resolveTarget({ url: "/elsewhere/p.html", stratum: "x" }, "/repo").logicalUrl).toBe("file:///elsewhere/p.html");
    expect(resolveTarget({ url: "https://example.com/a", stratum: "x" }, "/repo")).toEqual({ navUrl: "https://example.com/a", local: false });
    expect(() => resolveTarget({ url: "data:text/html,hi", stratum: "x" }, "/repo")).toThrow(/unsupported URL scheme/);
  });

  it("parseUrlList: JSON array, {urls}, CSV with quotes; rejects duplicates and missing fields", () => {
    const fromJson = (v: unknown) => parseUrlList({ files: () => [], file: () => new Uint8Array(), json: () => v });
    const fromCsv = (text: string) => parseUrlList({ files: () => ["urls.csv"], file: () => new TextEncoder().encode(text), json: () => null });
    expect(fromJson({ urls: [{ url: "a.html", stratum: "s", group_key: "g" }] })).toEqual([{ url: "a.html", stratum: "s", group_key: "g" }]);
    expect(fromCsv('url,category,group_key\n"https://e.com/a,b",article,\n# comment\nb.html,docs,grp\n')).toEqual([
      { url: "https://e.com/a,b", stratum: "article" },
      { url: "b.html", stratum: "docs", group_key: "grp" },
    ]);
    expect(splitCsvLine('a,"b ""q"" c",d')).toEqual(["a", 'b "q" c', "d"]);
    expect(() => fromJson([{ url: "a", stratum: "s" }, { url: "a", stratum: "t" }])).toThrow(/duplicate/);
    expect(() => fromJson([{ url: "a" }])).toThrow(/stratum/);
    expect(() => fromJson([])).toThrow(/empty/);
  });

  it("pageFlags ignores hidden text", () => {
    const node = (parent: number, text: string, display = "block") => ({ parent, own_text: text, text_len: 5000, style: { display, visibility: "visible" } });
    const many = Array.from({ length: 80 }, () => node(0, "filler"));
    const hiddenWall = [node(-1, ""), node(0, "", "none"), node(1, "Subscribe to continue reading"), ...many];
    expect(pageFlags({ http_status: 200, nodes: hiddenWall })).toEqual([]);
    const visibleWall = [node(-1, ""), node(0, "Subscribe to continue reading"), ...many];
    expect(pageFlags({ http_status: 200, nodes: visibleWall })).toEqual(["paywall"]);
  });
});
