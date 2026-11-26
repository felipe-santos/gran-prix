// Test harness: a local fixture server and a Chromium that carries the unpacked extension.
//
// Extensions need the full Chromium in "new headless" (`--headless=new`); the old headless shell, which
// `chromium.launch({ headless: true })` picks, has no extension support. `GP_CHROMIUM` / the newest cached Playwright
// Chromium is the same binary the collector uses (`findChromium` of @gran-prix/features).
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { findChromium } from "@gran-prix/features";

export const REPO = new URL("../../../../", import.meta.url).pathname;
export const FIXTURES = join(REPO, "fixtures", "pages");

/** Serves `fixtures/pages` on 127.0.0.1:<random port>; resolves { origin, close }. */
export async function serveFixtures(extra = {}) {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const override = extra[path];
    if (override !== undefined) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(override);
      return;
    }
    try {
      const body = readFileSync(join(FIXTURES, path.replace(/^\/+/, "")));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/**
 * Launches Chromium with the unpacked extension at `extensionDir`.
 * @returns {{ context, worker, extensionId, downloadsDir, close }}
 */
export async function launchWithExtension(extensionDir) {
  const exe = findChromium();
  if (!exe) throw new Error("no Chromium found: set GP_CHROMIUM or run `playwright-core install chromium`");
  const userDataDir = mkdtempSync(join(tmpdir(), "gp-ext-profile-"));
  const downloadsDir = mkdtempSync(join(tmpdir(), "gp-ext-downloads-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: exe,
    headless: false,
    acceptDownloads: true,
    downloadsPath: downloadsDir,
    args: ["--headless=new", "--no-sandbox", `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 }));
  const extensionId = new URL(worker.url()).host;
  return {
    context,
    worker,
    extensionId,
    downloadsDir,
    async close() {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(downloadsDir, { recursive: true, force: true });
    },
  };
}
