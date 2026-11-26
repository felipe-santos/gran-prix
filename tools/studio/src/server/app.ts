import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Mode } from "../core/types.js";
import { Calibration, CALIBRATION_TASK } from "./calibration.js";
import { DraftStore } from "./drafts.js";
import { HttpError, hostAllowed, newToken, originAllowed, send, sendJson, serveStatic, tokensEqual } from "./http.js";
import { HumanStore, StoreError, ANNOTATOR_RE, STUDIO_VERSION } from "./human-store.js";
import { handlePage, pageRow, type PageDeps, type PageScope } from "./page-routes.js";
import { PageCache } from "./pages.js";
import { queuesDir } from "./queues.js";
import { isHex, listPages, type PageRef } from "./snapshot-set.js";
import { Tasks } from "./task-routes.js";

export interface StudioOptions {
  dataDir: string;
  annotator: string;
  /** Mode of pages that have no saved state yet. Default `blind`: the safe one, no draft is ever shown. */
  defaultMode?: Mode;
  /** 0 = pick a free port. */
  port?: number;
  /** Fixed token (tests); default: random. */
  token?: string;
  /** Directory of the built UI (default: `dist/ui` next to the compiled server). */
  uiDir?: string;
  /** Optional path of the annotation guide, served as text at /api/guide so the quick-reference can link to it. */
  guidePath?: string;
  /** `fixtures/pages` of the repository (`<name>.truth.json` of the calibration exercise). Default: the one next to this package. */
  fixturesDir?: string;
  /** Directory of the label queues (`<task>.json`). Default: `<data-dir>/labeling/queues`. */
  queuesDir?: string;
  /** Clock of the `not_before` rule (tests). Default: the system clock. */
  now?: () => Date;
}

export interface RunningStudio {
  server: Server;
  port: number;
  token: string;
  /** `http://127.0.0.1:<port>/?token=...` */
  url: string;
  close(): Promise<void>;
}

const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const defaultUiDir = (): string => join(dirname(fileURLToPath(import.meta.url)), "..", "ui");

/** `fixtures/pages` of this repository, seen from `src/server` or `dist/server`. */
const defaultFixturesDir = (): string => join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "fixtures", "pages");

export async function startStudio(opts: StudioOptions): Promise<RunningStudio> {
  if (!ANNOTATOR_RE.test(opts.annotator)) throw new Error(`invalid annotator name ${JSON.stringify(opts.annotator)}`);
  const token = opts.token ?? newToken();
  const uiDir = opts.uiDir ?? defaultUiDir();
  const human = new HumanStore(opts.dataDir, opts.annotator, opts.defaultMode ?? "blind");
  const pages = new PageCache();
  const drafts = new DraftStore(opts.dataDir);
  let port = 0;

  const refOf = (hex: string): PageRef => {
    if (!isHex(hex)) throw new HttpError(404, "no such page");
    const ref = listPages(opts.dataDir).find((p) => p.hex === hex);
    if (!ref) throw new HttpError(404, "no such page");
    return ref;
  };

  const deps: PageDeps = { pages, drafts, refOf: (hex) => refOf(hex) };
  const now = opts.now ?? ((): Date => new Date());
  const calibration = new Calibration(new HumanStore(opts.dataDir, opts.annotator, "blind", CALIBRATION_TASK), pages, opts.fixturesDir ?? defaultFixturesDir(), () => listPages(opts.dataDir));
  const tasks = new Tasks({ dataDir: opts.dataDir, queuesDir: opts.queuesDir ?? queuesDir(opts.dataDir), annotator: opts.annotator, now, deps, calibration });

  /** The free mode: the annotator's own store, mode chosen per page. Pages of a BLIND queue task are served only inside it. */
  const freeScope: PageScope = {
    store: human,
    forcedMode: null,
    exportMeta: null,
    exportable: true,
    guard: (hex) => {
      const owner = tasks.blindQueuePages().get(hex);
      if (owner !== undefined) throw new HttpError(403, `this page belongs to the blind task "${owner}": open it from the task`);
    },
  };
  /** Pages of the free mode: every page of the data dir except the ones that belong to a blind queue task. */
  const freePages = (): PageRef[] => {
    const blind = tasks.blindQueuePages();
    return listPages(opts.dataDir).filter((r) => !blind.has(r.hex));
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host, port)) throw new HttpError(403, "bad Host header");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, "bad path encoding");
    }
    const method = req.method ?? "GET";

    // The built UI bundle holds no data: served without the token (the page that loads it needs one).
    if (method === "GET" && path.startsWith("/assets/")) return serveStatic(res, uiDir, path.slice(1));
    if (method === "GET" && path === "/favicon.ico") return send(res, 204, "");

    const given = (req.headers["x-studio-token"] as string | undefined) ?? (method === "GET" ? (url.searchParams.get("token") ?? undefined) : undefined);
    if (!tokensEqual(given, token)) throw new HttpError(401, "missing or wrong token");
    if (method !== "GET") {
      if (!originAllowed(req.headers.origin, port)) throw new HttpError(403, "cross-origin request refused");
      if (req.headers["x-studio-token"] === undefined) throw new HttpError(401, "state-changing requests need the X-Studio-Token header");
    }

    if (method === "GET" && path === "/") {
      const file = join(uiDir, "index.html");
      if (!existsSync(file)) throw new HttpError(503, "the UI is not built: run `pnpm --filter @gran-prix/studio build`");
      const html = readFileSync(file, "utf8").replace("</head>", `<meta name="gp-token" content="${token}"></head>`);
      return send(res, 200, html, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": APP_CSP });
    }
    if (method === "GET" && path === "/api/info") {
      return sendJson(res, 200, { annotator: opts.annotator, version: STUDIO_VERSION, guide: opts.guidePath !== undefined, data_dir: opts.dataDir });
    }
    if (method === "GET" && path === "/api/guide") {
      if (opts.guidePath === undefined) throw new HttpError(404, "no guide configured (start with --guide <file>)");
      return send(res, 200, readFileSync(opts.guidePath), { "Content-Type": "text/plain; charset=utf-8" });
    }
    if (method === "GET" && path === "/api/pages") {
      drafts.refresh();
      const seconds = human.secondsByPage();
      return sendJson(res, 200, { annotator: opts.annotator, pages: freePages().map((r) => pageRow(deps, freeScope, r, seconds)) });
    }
    if (method === "POST" && path === "/api/export") {
      const exported: string[] = [];
      const refused: Array<{ hex: string; unlabeled: number }> = [];
      for (const ref of freePages()) {
        const page = pages.load(ref);
        const r = human.exportPage(page);
        if (r.ok) exported.push(ref.hex);
        else refused.push({ hex: ref.hex, unlabeled: r.unlabeled.length });
      }
      return sendJson(res, 200, { exported, refused });
    }

    if (path === "/api/tasks" || path.startsWith("/api/tasks/")) return tasks.handle(req, res, path, url);

    const m = /^\/api\/pages\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
    if (m) return handlePage(deps, freeScope, req, res, m[1] as string, m[2], url);
    throw new HttpError(404, "not found");
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError || e instanceof StoreError ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) sendJson(res, status, { ok: false, error: message });
      else res.end();
    });
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    // 127.0.0.1 only: never 0.0.0.0, never ::. The interface is part of the privacy promise.
    server.listen(opts.port ?? 0, "127.0.0.1", ok);
  });
  port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    token,
    url: `http://127.0.0.1:${port}/?token=${token}`,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
