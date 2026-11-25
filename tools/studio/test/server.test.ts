import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { validate, type NodeLabels } from "@gran-prix/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { startStudio, type RunningStudio } from "../src/server/app.js";
import { listPages } from "../src/server/snapshot-set.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

const TOKEN = "test-token-0123456789";
const running: RunningStudio[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

/** A private, writable copy of the collected corpus (2 pages) plus a stub UI dir. */
function freshData(): { dataDir: string; uiDir: string } {
  const dataDir = tmpDir("gp-studio-data-");
  cpSync(inject("corpusDataDir"), dataDir, { recursive: true });
  const uiDir = tmpDir("gp-studio-ui-");
  mkdirSync(join(uiDir, "assets"));
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><html><head><title>t</title></head><body>ui</body></html>");
  writeFileSync(join(uiDir, "assets", "app.js"), "console.log(1)");
  return { dataDir, uiDir };
}

async function start(over: Partial<Parameters<typeof startStudio>[0]> = {}) {
  const d = freshData();
  const s = await startStudio({ dataDir: d.dataDir, uiDir: d.uiDir, annotator: "ana", token: TOKEN, ...over });
  running.push(s);
  const base = `http://127.0.0.1:${s.port}`;
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { "x-studio-token": TOKEN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: r.status, json: json as Record<string, any>, text, headers: r.headers };
  };
  return { ...d, s, base, api };
}

/** Raw request: lets the test send a Host header, or a path that `fetch` would normalize. */
function raw(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { "x-studio-token": TOKEN, ...headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

let pageHexes: string[];
beforeAll(() => {
  pageHexes = listPages(inject("corpusDataDir")).map((p) => p.hex);
});

describe("access control", () => {
  it("binds to 127.0.0.1 only", async () => {
    const { s } = await start();
    const addr = s.server.address();
    expect(addr).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
  });

  it("requires the token on every route but the (data-free) asset bundle", async () => {
    const { api, base } = await start();
    for (const path of ["/", "/api/info", "/api/pages", `/api/pages/${pageHexes[0]}`, `/api/pages/${pageHexes[0]}/frame`]) {
      const none = await fetch(`${base}${path}`);
      expect(none.status, path).toBe(401);
      const wrong = await fetch(`${base}${path}`, { headers: { "x-studio-token": "nope" } });
      expect(wrong.status, path).toBe(401);
    }
    expect((await fetch(`${base}/assets/app.js`)).status).toBe(200);
    expect((await api("GET", "/api/pages")).status).toBe(200);
    // the query token is accepted for GET (iframe src, first page load) ...
    expect((await fetch(`${base}/api/pages?token=${TOKEN}`)).status).toBe(200);
    expect((await fetch(`${base}/?token=${TOKEN}`)).status).toBe(200);
    // ... never for a state-changing request
    const put = await fetch(`${base}/api/pages/${pageHexes[0]}/state?token=${TOKEN}`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    expect(put.status).toBe(401);
  });

  it("injects the token into the page it serves and sets a strict CSP", async () => {
    const { base } = await start();
    const r = await fetch(`${base}/?token=${TOKEN}`);
    const html = await r.text();
    expect(html).toContain(`<meta name="gp-token" content="${TOKEN}">`);
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("refuses a Host header that is not the loopback name and port (DNS rebinding) and cross-origin writes", async () => {
    const { s, api } = await start();
    expect((await raw(s.port, "/api/pages", { host: "evil.example" })).status).toBe(403);
    expect((await raw(s.port, "/api/pages", { host: `evil.example:${s.port}` })).status).toBe(403);
    expect((await raw(s.port, "/api/pages", { host: `localhost:${s.port}` })).status).toBe(200);
    const r = await api("PUT", `/api/pages/${pageHexes[0]}/state`, { labels: {} }, { origin: "http://evil.example" });
    expect(r.status).toBe(403);
    const ok = await api("PUT", `/api/pages/${pageHexes[0]}/state`, { labels: {} }, { origin: `http://127.0.0.1:${s.port}` });
    expect(ok.status).toBe(200);
  });

  it("blocks path traversal in static files, page ids and annotator names", async () => {
    const { s, uiDir } = await start();
    writeFileSync(join(uiDir, "..", "secret-outside-ui.txt"), "secret");
    for (const p of ["/assets/..%2f..%2fsecret-outside-ui.txt", "/assets/%2e%2e/%2e%2e/secret-outside-ui.txt", "/assets/..%5c..%5csecret-outside-ui.txt", "/assets/%00", "/assets/../index.html"]) {
      const r = await raw(s.port, p);
      expect(r.status, p).toBeGreaterThanOrEqual(400);
      expect(r.body, p).not.toContain("secret");
    }
    for (const p of ["/api/pages/..%2f..%2f..%2fetc%2fpasswd/frame", "/api/pages/%2e%2e/frame", "/api/pages/abc/frame", `/api/pages/${"0".repeat(64)}/frame`]) {
      expect((await raw(s.port, p)).status, p).toBe(404);
    }
    await expect(startStudio({ dataDir: tmpDir(), annotator: "../evil", token: TOKEN })).rejects.toThrow(/annotator/);
    await expect(startStudio({ dataDir: tmpDir(), annotator: "a/b", token: TOKEN })).rejects.toThrow(/annotator/);
  });
});

describe("pages and the sandboxed frame", () => {
  it("lists the pages of the SnapshotSet with their U size and zero progress", async () => {
    const { api } = await start();
    const r = await api("GET", "/api/pages");
    expect(r.json["pages"]).toHaveLength(2);
    for (const p of r.json["pages"]) {
      expect(p).toMatchObject({ labeled: 0, complete: false, mode: "blind", exported: false });
      expect(p.units).toBeGreaterThan(5);
      expect(p.units).toBeLessThan(p.node_count);
    }
  });

  it("computes U from the snapshot: visible text in, display:none / sr-only / modal text out", async () => {
    const { api } = await start();
    const r = await api("GET", "/api/pages");
    const article = r.json["pages"].find((p: any) => p.category === "article");
    const page = (await api("GET", `/api/pages/${article.hex}`)).json;
    const nodes = page["nodes"] as Array<{ t: string; x: string; u: number }>;
    const u = (text: string) => nodes.find((n) => n.x.includes(text))?.u;
    expect(u("Keep reading for free")).toBe(0); // #subscribe-modal (display:none)
    expect(u("Skip to comments")).toBe(0); // .sr-only (left:-9999px)
    const h1 = nodes.find((n) => n.t === "h1");
    expect(h1?.u).toBe(1);
    expect(nodes.filter((n) => n.u !== 0)).toHaveLength(article.units);
    expect(nodes.every((n) => n.u === 0 || n.x !== "")).toBe(true);
  });

  it("serves the flattened html with a script-less CSP, details opened and no refresh/base tags", async () => {
    const { api } = await start();
    const r = await api("GET", `/api/pages/${pageHexes[0]}/frame`);
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox allow-same-origin");
    expect(csp).not.toMatch(/script-src/);
    expect(csp).not.toContain("allow-scripts");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-type")).toMatch(/^text\/html/);
    expect(r.text).toContain("data-gp-id=");
    expect(r.text).not.toMatch(/<base\b|http-equiv=["']?refresh/i);
  });
});

describe("saving labels", () => {
  it("round-trips the working state and writes it under human-labels/<annotator>/<snapshot hex>.json", async () => {
    const { api, dataDir } = await start();
    const hex = pageHexes[0] as string;
    const nodes = (await api("GET", `/api/pages/${hex}`)).json["nodes"] as Array<{ u: number }>;
    const unit = nodes.findIndex((n) => n.u !== 0);
    const labels = { explicit: { 0: "noise", [unit]: "main" }, flags: { [unit]: ["doubt", "mixed"] } };
    const saved = await api("PUT", `/api/pages/${hex}/state`, { labels });
    expect(saved.status).toBe(200);
    const file = join(dataDir, "human-labels", "ana", `${hex}.json`);
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk).toMatchObject({ format: "gran-prix.studio-labels", snapshot_id: `sha256:${hex}`, annotator: "ana", mode: "blind" });
    const back = await api("GET", `/api/pages/${hex}`);
    expect(back.json["state"]).toMatchObject({ explicit: { 0: "noise", [unit]: "main" }, flags: { [unit]: ["doubt", "mixed"] }, mode: "blind" });
    // progress shows in the list: root labeled noise covers the whole page, so every unit is labeled
    const list = await api("GET", "/api/pages");
    const row = list.json["pages"].find((p: any) => p.hex === hex);
    expect(row.labeled).toBe(row.units);
    expect(row.complete).toBe(true);
    expect(row.doubt).toBe(1);
  });

  it("drops invalid classes, flags and ids instead of storing them", async () => {
    const { api } = await start();
    const hex = pageHexes[0] as string;
    await api("PUT", `/api/pages/${hex}/state`, { labels: { explicit: { 3: "bogus", 5: "support", 99999: "main", x: "main" }, flags: { 5: ["nope"] } } });
    const back = await api("GET", `/api/pages/${hex}`);
    expect(back.json["state"].explicit).toEqual({ 5: "support" });
    expect(back.json["state"].flags).toEqual({});
  });

  it("appends to timelog.jsonl and never rewrites earlier lines", async () => {
    const { api, dataDir } = await start();
    const hex = pageHexes[0] as string;
    const t = (s: number) => ({ mode: "blind", start: new Date(Date.UTC(2026, 0, 1, 10, 0, 0)).toISOString(), end: new Date(Date.UTC(2026, 0, 1, 10, 0, s)).toISOString(), seconds: s });
    expect((await api("POST", `/api/pages/${hex}/time`, t(30))).status).toBe(200);
    const file = join(dataDir, "human-labels", "ana", "timelog.jsonl");
    const first = readFileSync(file, "utf8");
    expect((await api("POST", `/api/pages/${hex}/time`, t(45))).status).toBe(200);
    const all = readFileSync(file, "utf8");
    expect(all.startsWith(first)).toBe(true);
    const lines = all.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ page: `sha256:${hex}`, mode: "blind", seconds: 30, annotator: "ana" });
    expect(lines[1].seconds).toBe(45);
    const list = await api("GET", "/api/pages");
    expect(list.json["pages"].find((p: any) => p.hex === hex).seconds).toBe(75);
    // bad entries are refused, and active seconds cannot exceed the wall-clock span
    expect((await api("POST", `/api/pages/${hex}/time`, { ...t(10), seconds: -1 })).status).toBe(400);
    expect((await api("POST", `/api/pages/${hex}/time`, { ...t(10), start: "nope" })).status).toBe(400);
    const capped = await api("POST", `/api/pages/${hex}/time`, { ...t(10), seconds: 99999 });
    expect(capped.json["seconds"]).toBeLessThanOrEqual(11);
  });
});

describe("blind and review modes", () => {
  it("blind mode never returns a draft; review mode does, with the labeler that made it", async () => {
    const { api } = await start();
    const hex = pageHexes[0] as string;
    const blind = await api("GET", `/api/pages/${hex}`);
    expect(blind.json["state"].mode).toBe("blind");
    expect(blind.json).not.toHaveProperty("draft");
    expect(blind.json).not.toHaveProperty("drafts");
    expect(JSON.stringify(blind.json)).not.toMatch(/readability|llm/);
    const sw = await api("PUT", `/api/pages/${hex}/state`, { labels: {}, mode: "review" });
    expect(sw.status).toBe(200);
    const review = await api("GET", `/api/pages/${hex}`);
    expect(review.json["state"].mode).toBe("review");
    expect(review.json["draft"]?.labeler_id).toMatch(/^readability/);
    expect(Object.keys(review.json["draft"].labels).length).toBeGreaterThan(5);
  });

  it("a page that holds labels cannot change mode until it is reset", async () => {
    const { api } = await start();
    const hex = pageHexes[0] as string;
    await api("PUT", `/api/pages/${hex}/state`, { labels: { explicit: { 0: "noise" }, flags: {} } });
    const r = await api("PUT", `/api/pages/${hex}/state`, { labels: { explicit: { 0: "noise" }, flags: {} }, mode: "review" });
    expect(r.status).toBe(409);
    const reset = await api("PUT", `/api/pages/${hex}/state`, { labels: {}, mode: "review", reset: true });
    expect(reset.status).toBe(200);
    expect(reset.json["state"]).toMatchObject({ mode: "review", explicit: {} });
  });

  it("the default mode applies to pages without state; review shows stored drafts of a NodeLabelsSet before computing one", async () => {
    const { api, dataDir } = await start({ defaultMode: "review" });
    const hex = pageHexes[0] as string;
    const page = (await api("GET", `/api/pages/${hex}`)).json;
    expect(page["state"].mode).toBe("review");
    // store a NodeLabelsSet artifact with an llm-kind draft for the page
    const { buildNodeLabels } = await import("@gran-prix/labels");

    const units = (page["nodes"] as Array<{ u: number }>).flatMap((n, i) => (n.u !== 0 ? [i] : []));
    const doc = buildNodeLabels({
      snapshot_id: page["snapshot_id"],
      labeler: { id: "test-llm@1", kind: "llm", params: {} },
      items: units.map((unit_id) => ({ unit_id, y: 1, confidence: 0.8, source: "llm" as const })),
      n_candidates: units.length,
    });
    // an artifact of the store layout (`<id>/meta.json` + `<id>/files/...`), written by hand: the reader does not recompute ids
    const artDir = join(dataDir, "artifacts", `sha256-${"ab".repeat(32)}`);
    mkdirSync(join(artDir, "files", "labels"), { recursive: true });
    writeFileSync(join(artDir, "meta.json"), JSON.stringify({ kind: "files", type: "NodeLabelsSet" }));
    writeFileSync(join(artDir, "files", "labels", `${hex.slice(0, 12)}.json`), JSON.stringify(doc));
    const again = (await api("GET", "/api/pages")).json; // a listing refreshes the draft index
    expect(again["pages"]).toHaveLength(2);
    const review = (await api("GET", `/api/pages/${hex}`)).json;
    expect(review["draft"]).toMatchObject({ labeler_id: "test-llm@1", labels_id: doc.labels_id });
    expect(Object.values(review["draft"].labels)).toSatisfy((v: unknown) => (v as string[]).every((c) => c === "support"));
    // the Studio's own exports are not drafts
    expect((review["drafts"] as Array<{ labeler_id: string }>).every((d) => !d.labeler_id.startsWith("human@"))).toBe(true);
  });
});

describe("export", () => {
  it("refuses while any unit of U is unlabeled, lists the missing units, and writes nothing", async () => {
    const { api, dataDir } = await start();
    const hex = pageHexes[0] as string;
    const page = (await api("GET", `/api/pages/${hex}`)).json;
    const nodes = page["nodes"] as Array<{ u: number; p: number }>;
    const units = nodes.flatMap((n, i) => (n.u !== 0 ? [i] : []));
    // label every unit but the last two
    const explicit: Record<string, string> = {};
    for (const u of units.slice(0, -2)) explicit[u] = "support";
    await api("PUT", `/api/pages/${hex}/state`, { labels: { explicit, flags: {} } });
    const r = await api("POST", `/api/pages/${hex}/export`, {});
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ ok: false, error: "unlabeled", n_unlabeled: 2 });
    expect(r.json["unlabeled"].map((x: any) => x.unit_id)).toEqual(units.slice(-2));
    expect(r.json["unlabeled"][0].text).toBeTypeOf("string");
    expect(existsSync(join(dataDir, "human-labels", "ana", "export"))).toBe(false);
  });

  it("exports contract-valid NodeLabels (source=human) once every unit is labeled, with flags in `reason`", async () => {
    const { api, dataDir } = await start({ annotator: "joana" });
    const hex = pageHexes[0] as string;
    const page = (await api("GET", `/api/pages/${hex}`)).json;
    const units = (page["nodes"] as Array<{ u: number }>).flatMap((n, i) => (n.u !== 0 ? [i] : []));
    // root = noise; the first unit is an explicit exception (main, doubt + mixed)
    const first = units[0] as number;
    await api("PUT", `/api/pages/${hex}/state`, { labels: { explicit: { 0: "noise", [first]: "main" }, flags: { [first]: ["mixed", "doubt"] } } });
    const r = await api("POST", `/api/pages/${hex}/export`, {});
    expect(r.status).toBe(200);
    expect(r.json["n_labeled"]).toBe(units.length);
    const file = join(dataDir, "human-labels", "joana", "export", "labels", `${hex.slice(0, 12)}.json`);
    expect(r.json["path"]).toBe(file);
    const doc = JSON.parse(readFileSync(file, "utf8")) as NodeLabels & Record<string, any>;
    const v = validate("node-labels", doc);
    expect(v.issues).toEqual([]);
    expect(v.ok).toBe(true);
    expect(doc.labeler).toMatchObject({ id: "human@joana", kind: "human" });
    expect(doc.snapshot_id).toBe(`sha256:${hex}`);
    expect(doc.label_space).toEqual({ kind: "multiclass", classes: ["main", "support", "noise"] });
    expect(doc.items.every((i) => i.source === "human" && i.confidence === 1)).toBe(true);
    expect(doc.items.map((i) => i.unit_id)).toEqual(units);
    expect(doc.items[0]).toMatchObject({ unit_id: first, y: 0, reason: "doubt,mixed" });
    expect(doc.items[1]).toMatchObject({ y: 2 });
    expect(doc.items[1]).not.toHaveProperty("reason");
    expect(doc.coverage).toEqual({ n_labeled: units.length, n_candidates: units.length });
    expect(doc["studio"]).toMatchObject({ mode: "blind", n_doubt: 1, n_mixed: 1 });
    // re-export of the same labels is byte-identical (same labels_id)
    const again = await api("POST", `/api/pages/${hex}/export`, {});
    expect(again.json["labels_id"]).toBe(doc.labels_id);
    // the list shows it as exported
    expect((await api("GET", "/api/pages")).json["pages"].find((p: any) => p.hex === hex).exported).toBe(true);
  });

  it("export-all exports the complete pages and reports the others", async () => {
    const { api } = await start();
    const [a, b] = pageHexes as [string, string];
    await api("PUT", `/api/pages/${a}/state`, { labels: { explicit: { 0: "main" }, flags: {} } });
    const r = await api("POST", "/api/export", {});
    expect(r.json["exported"]).toEqual([a]);
    expect(r.json["refused"]).toHaveLength(1);
    expect(r.json["refused"][0]).toMatchObject({ hex: b });
    expect(r.json["refused"][0].unlabeled).toBeGreaterThan(0);
  });

  it("the exported directory is a NodeLabelsSet layout: labels/<hex12>.json files only", async () => {
    const { api, dataDir } = await start();
    const hex = pageHexes[1] as string;
    await api("PUT", `/api/pages/${hex}/state`, { labels: { explicit: { 0: "support" }, flags: {} } });
    await api("POST", `/api/pages/${hex}/export`, {});
    expect(readdirSync(join(dataDir, "human-labels", "ana", "export", "labels"))).toEqual([`${hex.slice(0, 12)}.json`]);
  });
});
