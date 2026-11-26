// End to end: the unpacked extension in a real Chromium captures a served fixture, and the pair it downloads is the
// pair the collect stage would have written (same ids, same text, same flattened html).
//
// What this does NOT cover: the toolbar click itself. Browser automation cannot click an extension icon, and that click is
// what grants `activeTab`; so these tests load dist-test/, whose manifest is the shipped one plus host_permissions for
// 127.0.0.1, and call the function the click ends up calling (`self.gpCaptureTab`, also reachable through the popup page
// opened as a tab with ?tab=<id>). The shipped dist/ manifest is checked statically below.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, contractId, sha256Of, validate } from "@gran-prix/contracts";
import * as features from "@gran-prix/features";
import { SnapshotSetReader } from "@gran-prix/labels";
import { importCaptures } from "../../corpus/src/import-captures.mjs";
import { buildExtension } from "../scripts/build.mjs";
import { launchWithExtension, serveFixtures } from "./helpers/browser.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const DIST_TEST = join(ROOT, "dist-test");

let srv;
let ext;
const requests = [];

beforeAll(async () => {
  await buildExtension({ outDir: DIST });
  await buildExtension({ outDir: DIST_TEST, hostPermissions: ["http://127.0.0.1/*", "http://localhost/*"] });
  const rows = Array.from({ length: 6000 }, (_, i) => `<li><a href="/item/${i}">Item ${i}</a> <span>Texto do item ${i} com algumas palavras para o corpo</span></li>`).join("\n");
  srv = await serveFixtures({ "/big.html": `<!doctype html><html lang="pt"><head><title>Grande</title></head><body><main><h1>Lista grande</h1><ul>${rows}</ul></main></body></html>` });
  ext = await launchWithExtension(DIST_TEST);
  ext.context.on("request", (r) => requests.push(r.url()));
});

afterAll(async () => {
  await ext?.close();
  await srv?.close();
});

/** Opens `path`, spies on chrome.downloads.download, runs the capture, and returns what was requested and what landed on disk. */
async function captureViaWorker(path) {
  const page = await ext.context.newPage();
  await page.goto(`${srv.origin}${path}`);
  const tabId = await ext.worker.evaluate(async (origin) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(origin))?.id, `${srv.origin}${path}`);
  expect(typeof tabId).toBe("number");
  await ext.worker.evaluate(() => {
    self.__requested = [];
    if (!self.__origDownload) self.__origDownload = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = (o) => {
      self.__requested.push({ filename: o.filename, conflictAction: o.conflictAction, saveAs: o.saveAs, mime: o.url.slice(5, o.url.indexOf(";")) });
      return self.__origDownload(o);
    };
  });
  const before = new Set(readdirSync(ext.downloadsDir));
  const result = await ext.worker.evaluate((id) => self.gpCaptureTab(id), tabId);
  const requested = await ext.worker.evaluate(() => self.__requested);
  // Playwright's download handling stores every download under a GUID name, so the files are told apart by content.
  const landed = readdirSync(ext.downloadsDir).filter((f) => !before.has(f)).map((f) => readFileSync(join(ext.downloadsDir, f)));
  const gz = landed.find((b) => b[0] === 0x1f && b[1] === 0x8b);
  const json = landed.find((b) => b !== gz);
  return { page, tabId, result, requested, snapshot: JSON.parse(json.toString("utf8")), jsonText: json.toString("utf8"), html: gunzipSync(gz).toString("utf8"), gz, json };
}

describe("shipped manifest (dist/)", () => {
  const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
  it("asks for exactly activeTab, scripting and downloads; no host permissions, content scripts or web-accessible resources", () => {
    expect(manifest.manifest_version).toBe(3);
    expect([...manifest.permissions].sort()).toEqual(["activeTab", "downloads", "scripting"]);
    for (const k of ["host_permissions", "optional_host_permissions", "optional_permissions", "content_scripts", "web_accessible_resources", "externally_connectable", "declarative_net_request", "sandbox"]) {
      expect(manifest, k).not.toHaveProperty(k);
    }
  });
  it("keeps the MV3 CSP that forbids remote and eval code", () => {
    expect(manifest.content_security_policy.extension_pages).toBe("script-src 'self'; object-src 'self'");
  });
  it("contains no network or dynamic-code primitive in any shipped script", () => {
    for (const f of readdirSync(DIST).filter((n) => n.endsWith(".js"))) {
      const src = readFileSync(join(DIST, f), "utf8");
      for (const needle of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /\bsendBeacon\b/, /\beval\s*\(/, /new Function\b/, /importScripts/, /https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i]) {
        // the only URLs allowed in the probe bundle are inside text the probe reads from the page, never as a destination
        if (f === "gp-features.iife.js" && needle.source.startsWith("https?")) continue;
        expect(needle.test(src), `${f} matches ${needle}`).toBe(false);
      }
    }
  });
  it("the shipped dist/ differs from dist-test/ only by host_permissions", () => {
    const t = JSON.parse(readFileSync(join(DIST_TEST, "manifest.json"), "utf8"));
    const { host_permissions, ...rest } = t;
    expect(host_permissions).toEqual(["http://127.0.0.1/*", "http://localhost/*"]);
    expect(rest).toEqual(manifest);
    for (const f of ["background.js", "popup.js", "popup.html", "gp-features.iife.js", "flatten-page.js"]) {
      expect(readFileSync(join(DIST, f), "utf8") === readFileSync(join(DIST_TEST, f), "utf8"), f).toBe(true);
    }
  });
  it("injects the very bundle the collect stage injects", () => {
    expect(readFileSync(join(DIST, "gp-features.iife.js"), "utf8")).toBe(features.bundleSource());
  });
});

describe("capture of fixtures/pages/docs-3.html", () => {
  let cap;
  let collected;

  beforeAll(async () => {
    cap = await captureViaWorker("/docs-3.html");
    // The collect stage's own capture code, on the same URL served over http (so url, group_key and the id scheme line up).
    const { capturePage } = await import("../../cli/dist/stages/collect/capture.js");
    const { resolveTarget } = await import("../../cli/dist/stages/collect/target.js");
    const { browser, context } = await features.launch({ viewport: { width: 1366, height: 900 } });
    await context.close();
    try {
      const entry = { url: `${srv.origin}/docs-3.html`, stratum: "docs" };
      const got = await capturePage(browser, entry, resolveTarget(entry, ROOT), {
        features, bundle: features.bundleSource(), viewport: { width: 1366, height: 900 }, quietMs: 600, maxMs: 8000, networkIdleCapMs: 3000,
        navTimeoutMs: 30_000, maxNodes: undefined, capturedAt: undefined, waitLabel: undefined, privateSuffixes: true,
      });
      const files = got.files;
      const snapPath = Object.keys(files).find((p) => p.startsWith("snapshots/"));
      const htmlPathKey = Object.keys(files).find((p) => p.startsWith("html/"));
      collected = { snapshot: JSON.parse(files[snapPath]), html: gunzipSync(files[htmlPathKey]).toString("utf8"), files };
    } finally {
      await browser.close();
    }
  });

  it("downloads the pair into gp-captures/, named by the snapshot hash and never by the page title", () => {
    const hex = cap.snapshot.snapshot_id.replace(/^sha256:/, "");
    expect(cap.requested.map((r) => r.filename)).toEqual([`gp-captures/${hex}.json`, `gp-captures/${hex}.html.gz`]);
    expect(cap.requested.every((r) => r.saveAs === false && r.conflictAction === "overwrite")).toBe(true);
    expect(cap.requested.map((r) => r.mime)).toEqual(["application/json", "application/gzip"]);
    expect(cap.snapshot.page.title).toBeTruthy();
    for (const r of cap.requested) expect(r.filename.toLowerCase()).not.toContain(String(cap.snapshot.page.title).toLowerCase().split(/\s+/)[0]);
    expect(cap.result.files).toEqual(cap.requested.map((r) => r.filename));
    expect(cap.result.nodes).toBe(cap.snapshot.nodes.length);
  });

  it("the snapshot validates against the page-snapshot contract and its hashes are right", () => {
    const checked = validate("page-snapshot", cap.snapshot);
    expect(checked.ok, JSON.stringify(checked.ok ? [] : checked.issues.slice(0, 3))).toBe(true);
    const { snapshot_id, ...body } = cap.snapshot;
    expect(contractId("page-snapshot", body)).toBe(snapshot_id);
    expect(cap.snapshot.html.sha256).toBe(sha256Of(cap.html));
    expect(cap.snapshot.html.bytes).toBe(Buffer.byteLength(cap.html, "utf8"));
    expect(cap.snapshot.html.path).toBe(`html/${cap.snapshot.html.sha256.replace(/^sha256:/, "")}.html.gz`);
    expect(cap.snapshot.html.content_encoding).toBe("gzip");
    expect(cap.jsonText).toBe(`${canonicalJson(cap.snapshot)}\n`);
  });

  it("records what is real about the owner's browser, and the stratum", () => {
    const c = cap.snapshot.capture;
    expect(cap.snapshot.page.category).toBe("logged_in");
    expect(c.collector_version).toBe("gp-capture-ext/0.1.0");
    expect(c.user_agent).toMatch(/Chrome\/\d+/);
    expect(c.browser).toEqual({ name: "chromium", version: expect.stringMatching(/^\d+\.\d+\.\d+\.\d+$/) });
    expect(c.http_status).toBe(200);
    expect(c.wait_strategy).toBe("extension-click+dom-quiet(600ms,cap 8000ms)");
    expect(c.network).toBe("skipped");
    expect(c.flags).toEqual([]);
    expect(cap.snapshot.doc.viewport_w).toBeGreaterThan(0);
    expect(cap.snapshot.doc.viewport_h).toBeGreaterThan(0);
    expect(cap.snapshot.page.group_key).toBe("127.0.0.1");
  });

  it("node ids, structure and text equal the collect stage's snapshot of the same page", () => {
    const pick = (s) => s.nodes.map((n) => ({ idx: n.idx, parent: n.parent, depth: n.depth, tag: n.tag, attrs: n.attrs, own_text: n.own_text, text_len: n.text_len }));
    expect(cap.snapshot.nodes.length).toBe(collected.snapshot.nodes.length);
    expect(pick(cap.snapshot)).toEqual(pick(collected.snapshot));
    expect(cap.snapshot.text_units).toEqual(collected.snapshot.text_units);
    expect(cap.snapshot.probe).toEqual(collected.snapshot.probe);
    expect(cap.snapshot.page.title).toBe(collected.snapshot.page.title);
    expect(cap.snapshot.page.url).toBe(collected.snapshot.page.url);
    expect(cap.snapshot.page.url_key).toBe(collected.snapshot.page.url_key);
    expect(cap.html).toBe(collected.html);
    expect(cap.snapshot.html.sha256).toBe(collected.snapshot.html.sha256);
  });

  it("only the rect (and viewport-dependent style) may differ from the collect stage's nodes; the viewport and settle origin are the owner's", () => {
    const strip = (s) => s.nodes.map(({ rect, ...n }) => n);
    const a = strip(cap.snapshot);
    const b = strip(collected.snapshot);
    const diff = a.flatMap((n, i) => Object.keys(n).filter((k) => JSON.stringify(n[k]) !== JSON.stringify(b[i][k])).map((k) => k));
    // Measured on docs-3: only `rect` differs. `style` is allowed too because computed styles can depend on the viewport
    // width through media queries; ids, structure and text cannot.
    expect([...new Set(diff)].filter((k) => !["rect", "style"].includes(k))).toEqual([]);
  });
});

describe("end to end: extension download -> gp-corpus import-captures", () => {
  it("the downloaded pair imports into a SnapshotSet of the stratum logged_in that the pipeline's reader opens", async () => {
    const cap = await captureViaWorker("/docs-3.html");
    const work = mkdtempSync(join(tmpdir(), "gp-ext-import-"));
    try {
      // The owner's disk has the files under the names the extension asked for (Playwright renames downloads, so they are restored here).
      const incoming = join(work, "incoming");
      mkdirSync(incoming);
      const [jsonName, gzName] = cap.requested.map((r) => basename(r.filename));
      writeFileSync(join(incoming, jsonName), cap.json);
      writeFileSync(join(incoming, gzName), cap.gz);
      const out = join(work, "logged-in");
      const r = await importCaptures(incoming, out);
      expect(r.problems).toEqual([]);
      expect(r.imported).toEqual([jsonName.replace(/\.json$/, "")]);
      const reader = new SnapshotSetReader({ file: (p) => readFileSync(join(out, p)) });
      const [entry] = reader.entries();
      expect(entry.stratum).toBe("logged_in");
      expect(entry.snapshot_id).toBe(cap.snapshot.snapshot_id);
      expect(reader.snapshot(entry).snapshot_id).toBe(cap.snapshot.snapshot_id);
      expect(reader.html(entry)).toBe(cap.html);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("the popup (what the owner sees)", () => {
  it("shows 'capturado: N nós, X KB' and the privacy warning after the capture", async () => {
    const page = await ext.context.newPage();
    await page.goto(`${srv.origin}/docs-3.html`);
    const tabId = await ext.worker.evaluate(async (origin) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(origin))?.id, `${srv.origin}/docs-3.html`);
    const popup = await ext.context.newPage();
    await popup.goto(`chrome-extension://${ext.extensionId}/popup.html?tab=${tabId}`);
    await popup.waitForFunction(() => /^capturado: \d+ nós, \d+ KB$/.test(document.getElementById("status").textContent), null, { timeout: 30_000 });
    expect(await popup.locator("#status").textContent()).toMatch(/^capturado: \d+ nós, \d+ KB$/);
    expect(await popup.locator("#detail").textContent()).toMatch(/^Downloads\/gp-captures\/[0-9a-f]{64}\.json/);
    expect((await popup.locator("body").textContent()).replace(/\s+/g, " ")).toContain("Fica no seu disco; não envie a ninguém.");
  });

  it("explains the failure on a page it cannot read", async () => {
    // host_permissions cover only 127.0.0.1, so the URL of any other tab is hidden from the extension: the "no permission" message.
    const known = await ext.worker.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.id));
    const blank = await ext.context.newPage();
    await blank.goto("about:blank");
    const tabId = await ext.worker.evaluate(async (k) => (await chrome.tabs.query({})).find((t) => !k.includes(t.id))?.id, known);
    const popup = await ext.context.newPage();
    await popup.goto(`chrome-extension://${ext.extensionId}/popup.html?tab=${tabId}`);
    await popup.waitForFunction(() => document.getElementById("status").textContent === "Não capturou.", null, { timeout: 30_000 });
    expect(await popup.locator("#detail").textContent()).toContain("sem permissão para esta aba");
  });
});

describe("a big page (data: URL download limit) and the network", () => {
  it("captures thousands of nodes; the multi-MB files are written and valid", async () => {
    const cap = await captureViaWorker("/big.html");
    expect(cap.snapshot.nodes.length).toBeGreaterThan(12_000);
    expect(cap.jsonText.length).toBeGreaterThan(3_000_000);
    expect(validate("page-snapshot", cap.snapshot).ok).toBe(true);
    const { snapshot_id, ...body } = cap.snapshot;
    expect(contractId("page-snapshot", body)).toBe(snapshot_id);
    expect(cap.snapshot.html.sha256).toBe(sha256Of(cap.html));
  });

  it("made no request outside the page it was asked to capture (the fixture server)", () => {
    const outside = requests.filter((u) => !u.startsWith(srv.origin) && !u.startsWith(`chrome-extension://${ext.extensionId}/`) && !u.startsWith("data:") && !u.startsWith("about:"));
    expect(outside).toEqual([]);
  });
});
