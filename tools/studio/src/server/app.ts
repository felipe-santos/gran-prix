import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { effectiveLabels, progressOf } from "../core/labels.js";
import type { Mode } from "../core/types.js";
import { DraftStore, type DraftSet } from "./drafts.js";
import { HttpError, hostAllowed, newToken, originAllowed, readJson, send, sendJson, serveStatic, tokensEqual } from "./http.js";
import { HumanStore, StoreError, ANNOTATOR_RE, STUDIO_VERSION, type PageState } from "./human-store.js";
import { FRAME_CSP, PageCache, readFrame, type PageData } from "./pages.js";
import { isHex, listPages, type PageRef } from "./snapshot-set.js";

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

const UNLABELED_LIST_CAP = 500;

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
  const pageOf = (hex: string): PageData => pages.load(refOf(hex));

  /** Drafts are only ever exposed for a page in review mode: the server, not the UI, keeps blind mode blind. */
  async function draftsFor(page: PageData, state: PageState, wanted: string | null): Promise<{ list: DraftSet[]; chosen: DraftSet | null }> {
    if (state.mode !== "review") return { list: [], chosen: null };
    const list = await drafts.forPage(page);
    const id = wanted ?? state.draft?.labels_id ?? null;
    return { list, chosen: list.find((d) => d.labels_id === id) ?? list[0] ?? null };
  }

  function row(ref: PageRef, seconds: Map<string, number>): Record<string, unknown> {
    const base = { hex: ref.hex, snapshot_id: ref.entry.snapshot_id, url: ref.entry.url, category: ref.entry.stratum, node_count: ref.entry.node_count };
    try {
      const page = pages.load(ref);
      const state = human.load(ref.hex, page.nodes.length);
      const p = progressOf(page.model, state, effectiveLabels(page.model, state));
      return {
        ...base,
        title: page.snapshot.page.title ?? "",
        units: p.total,
        labeled: p.labeled,
        doubt: p.doubt,
        mixed: p.mixed,
        mode: state.mode,
        complete: p.total > 0 && p.labeled === p.total,
        exported: existsSync(join(human.dir, "export", "labels", `${ref.hex.slice(0, 12)}.json`)),
        seconds: seconds.get(ref.hex) ?? 0,
      };
    } catch (e) {
      return { ...base, error: e instanceof Error ? e.message : String(e) };
    }
  }

  function unlabeledReport(page: PageData, ids: number[]): Array<{ unit_id: number; tag: string; text: string }> {
    return ids.slice(0, UNLABELED_LIST_CAP).map((i) => ({ unit_id: i, tag: page.nodes[i]?.t ?? "", text: page.nodes[i]?.x ?? "" }));
  }

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
      return sendJson(res, 200, { annotator: opts.annotator, pages: listPages(opts.dataDir).map((r) => row(r, seconds)) });
    }
    if (method === "POST" && path === "/api/export") {
      const exported: string[] = [];
      const refused: Array<{ hex: string; unlabeled: number }> = [];
      for (const ref of listPages(opts.dataDir)) {
        const page = pages.load(ref);
        const r = human.exportPage(page);
        if (r.ok) exported.push(ref.hex);
        else refused.push({ hex: ref.hex, unlabeled: r.unlabeled.length });
      }
      return sendJson(res, 200, { exported, refused });
    }

    const m = /^\/api\/pages\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
    if (m) {
      const hex = m[1] as string;
      const sub = m[2];
      if (method === "GET" && sub === "frame") {
        const ref = refOf(hex);
        return send(res, 200, readFrame(ref), { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": FRAME_CSP });
      }
      const page = pageOf(hex);
      if (method === "GET" && sub === undefined) {
        const state = human.load(hex, page.nodes.length);
        const { list, chosen } = await draftsFor(page, state, url.searchParams.get("draft"));
        return sendJson(res, 200, {
          hex,
          snapshot_id: page.snapshot.snapshot_id,
          url: page.snapshot.page.final_url,
          title: page.snapshot.page.title ?? "",
          category: page.snapshot.page.category,
          nodes: page.nodes,
          state: { explicit: state.explicit, flags: state.flags, mode: state.mode, draft: state.draft },
          seconds: human.secondsByPage().get(hex) ?? 0,
          ...(state.mode === "review"
            ? { drafts: list.map(({ draft: _d, ...info }) => info), draft: chosen ? { labels_id: chosen.labels_id, labeler_id: chosen.labeler_id, labels: chosen.draft } : null }
            : {}),
        });
      }
      if (method === "PUT" && sub === "state") {
        const body = await readJson(req);
        const saved = human.save(page, { labels: body["labels"], mode: body["mode"], draft: body["draft"], reset: body["reset"] });
        const state = { explicit: saved.explicit, flags: saved.flags, mode: saved.mode, draft: saved.draft };
        return sendJson(res, 200, { state });
      }
      if (method === "POST" && sub === "time") {
        const body = await readJson(req);
        return sendJson(res, 200, human.logTime(hex, body));
      }
      if (method === "POST" && sub === "export") {
        const r = human.exportPage(page);
        if (r.ok) return sendJson(res, 200, { ok: true, path: r.path, labels_id: r.doc.labels_id, n_labeled: r.doc.coverage.n_labeled });
        return sendJson(res, 409, { ok: false, error: "unlabeled", message: `${r.unlabeled.length} unit(s) of U have no label`, unlabeled: unlabeledReport(page, r.unlabeled), n_unlabeled: r.unlabeled.length });
      }
    }
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
