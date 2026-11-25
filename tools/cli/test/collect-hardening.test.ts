// collect on hostile pages (local HTTP server, full gp collect stage): Trusted Types enforcement and DOM clobbering must not
// make a page un-snapshottable. Synthetic pages only; the 13 fixtures' ids are checked elsewhere.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PipelineSpec, type Sha256 } from "@gran-prix/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore, dataPaths, runPipeline } from "../src/index.js";
import { SnapshotSetReader } from "../src/stages/collect-stages.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

const filler = "Plain invented sentence about nothing in particular. ".repeat(12);
const SCRIPTS = `<script>window.__a = 1; /* SECRET-SCRIPT-SOURCE */</script><script id="s2" type="application/json">{"k":"SECRET-JSON"}</script>`;
const shell = (head: string, body: string): string => `<!doctype html><html lang="en"><head><title>Hostile</title>${head}</head><body>${body}</body></html>`;

/** Names that shadow what a collector reads on a form (HTMLFormElement) and on `document` (img/embed named like Document members). */
const FORM_NAMES = ["children", "childNodes", "shadowRoot", "getAttribute", "attributes", "tagName", "outerHTML", "firstChild", "nodeType", "removeChild", "prepend", "append"];
const DOC_NAMES = ["documentElement", "cloneNode", "querySelector", "querySelectorAll", "createDocumentFragment", "importNode", "doctype", "title"];
const CLOBBER = shell(
  "",
  `<main><h1>Checkout</h1><p>${filler}</p>
   <form id="f"><label>Quantity</label>${FORM_NAMES.map((n) => `<input name="${n}" value="1">`).join("")}<button type="submit">Buy</button></form>
   ${DOC_NAMES.map((n) => `<img name="${n}" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`).join("")}
   <div id="host"><template shadowrootmode="open"><p>SHADOW-TEXT inside an open shadow root</p></template></div>
   ${SCRIPTS}</main>`,
);

const ROUTES: Record<string, { headers?: Record<string, string>; body: string }> = {
  "/tt-header": { headers: { "content-security-policy": "require-trusted-types-for 'script'" }, body: shell("", `<main><h1>Trusted</h1><p>${filler}</p>${SCRIPTS}</main>`) },
  "/tt-meta": { body: shell(`<meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'">`, `<main><h1>Trusted</h1><p>${filler}</p>${SCRIPTS}</main>`) },
  "/clobbered": { body: CLOBBER },
  "/clobbered-tt": { headers: { "content-security-policy": "require-trusted-types-for 'script'" }, body: CLOBBER },
};

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const r = ROUTES[req.url ?? ""];
    if (!r) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...r.headers });
    res.end(r.body);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

function spec(urls: string): PipelineSpec {
  return {
    format: "gran-prix.pipeline-spec",
    format_version: "1.0.0",
    name: "collect-hardening",
    externals: { urls: { type: "UrlList", path: urls } },
    stages: [
      {
        id: "collect",
        kind: "collect",
        impl: "ts:collect.playwright@1.0.0",
        params: { viewport: [900, 700], settle: { quiet_ms: 200, max_ms: 2000, network_idle_cap_ms: 500 }, fail_on_error: true },
        inputs: { urls: { external: "urls" } },
      },
    ],
  };
}

describe("collect: hostile pages", () => {
  it("snapshots Trusted Types pages (header and meta CSP) and clobbered pages, inlines shadow roots and empties scripts", async () => {
    const dir = tmpDir("gp-collect-hardening-");
    mkdirSync(dir, { recursive: true });
    const paths = Object.keys(ROUTES);
    writeFileSync(join(dir, "urls.json"), JSON.stringify(paths.map((p) => ({ url: `${base}${p}`, stratum: "article" }))));
    const dataDir = join(dir, "data");
    const run = await runPipeline(spec(join(dir, "urls.json")), { dataDir });
    expect(run.ok, JSON.stringify(run.stages.map((s) => s.error))).toBe(true);
    const id = run.stages[0]?.outputs["snapshots"];
    const set = new SnapshotSetReader(new ArtifactStore(dataPaths(dataDir).artifacts).handle(id as Sha256, "SnapshotSet"));
    expect(set.manifest().failures).toEqual([]);
    const entries = set.entries();
    expect(entries.map((e) => e.url.replace(base, ""))).toEqual(paths);
    for (const e of entries) {
      const html = set.html(e);
      expect(html, e.url).not.toContain("SECRET-SCRIPT-SOURCE");
      expect(html, e.url).not.toContain("SECRET-JSON");
      expect(html, e.url).toContain("data-gp-id");
      expect(e.node_count, e.url).toBeGreaterThan(8);
    }
    for (const e of entries.filter((x) => x.url.includes("/clobbered"))) {
      expect(set.html(e), e.url).toContain("SHADOW-TEXT"); // the open shadow root was inlined
      expect(e.node_count, e.url).toBeGreaterThan(FORM_NAMES.length + DOC_NAMES.length + 10);
    }
  });
});
