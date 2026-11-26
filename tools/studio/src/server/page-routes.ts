import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { effectiveLabels, progressOf } from "../core/labels.js";
import type { Mode } from "../core/types.js";
import type { DraftSet, DraftStore } from "./drafts.js";
import { HttpError, readJson, send, sendJson } from "./http.js";
import type { ExportMeta, HumanStore, PageState } from "./human-store.js";
import { FRAME_CSP, readFrame, type PageCache, type PageData } from "./pages.js";
import type { PageRef } from "./snapshot-set.js";

/**
 * The page endpoints (document, frame, state, time, export), shared by the free mode (`/api/pages/<hex>/...`) and by
 * every task (`/api/tasks/<task>/pages/<hex>/...`). What differs between them is the SCOPE:
 *  - which store holds the labels (a task has its own, so the retest never sees the audit's labels);
 *  - which mode the page is in: a task fixes it (`blind` never gets a draft, whatever the request says);
 *  - which provenance an export carries (`task`, `plan_sha256`);
 *  - whether the page may be served at all (`guard`).
 * The server, not the UI, keeps blind pages blind: drafts are looked up only when the EFFECTIVE mode is `review`.
 */
export interface PageScope {
  store: HumanStore;
  /** Mode imposed on every page of the scope; `null`: the saved mode of the page (free mode). */
  forcedMode: Mode | null;
  /** Provenance written into exports; `null` in free mode. */
  exportMeta: ExportMeta | null;
  /** `false`: nothing is exported from this scope (the calibration exercise). */
  exportable: boolean;
  /** Throws an HttpError when the page may not be served in this scope. */
  guard(hex: string): void;
}

export interface PageDeps {
  pages: PageCache;
  drafts: DraftStore;
  refOf(hex: string): PageRef;
}

const effectiveMode = (scope: PageScope, state: PageState): Mode => scope.forcedMode ?? state.mode;

/** Drafts are only ever exposed for a page in review mode. */
async function draftsFor(deps: PageDeps, page: PageData, mode: Mode, state: PageState, wanted: string | null): Promise<{ list: DraftSet[]; chosen: DraftSet | null }> {
  if (mode !== "review") return { list: [], chosen: null };
  const list = await deps.drafts.forPage(page);
  const id = wanted ?? state.draft?.labels_id ?? null;
  return { list, chosen: list.find((d) => d.labels_id === id) ?? list[0] ?? null };
}

/** The row of a page in a list: progress, mode, time, export state. */
export function pageRow(deps: PageDeps, scope: PageScope, ref: PageRef, seconds: Map<string, number>): Record<string, unknown> {
  const base = { hex: ref.hex, snapshot_id: ref.entry.snapshot_id, url: ref.entry.url, category: ref.entry.stratum, node_count: ref.entry.node_count };
  try {
    const page = deps.pages.load(ref);
    const state = scope.store.load(ref.hex, page.nodes.length);
    const p = progressOf(page.model, state, effectiveLabels(page.model, state));
    return {
      ...base,
      title: page.snapshot.page.title ?? "",
      units: p.total,
      labeled: p.labeled,
      doubt: p.doubt,
      mixed: p.mixed,
      mode: effectiveMode(scope, state),
      complete: p.total > 0 && p.labeled === p.total,
      exported: existsSync(join(scope.store.dir, "export", "labels", `${ref.hex.slice(0, 12)}.json`)),
      seconds: seconds.get(ref.hex) ?? 0,
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

function unlabeledReport(page: PageData, ids: number[]): Array<{ unit_id: number; tag: string; text: string }> {
  return ids.slice(0, 500).map((i) => ({ unit_id: i, tag: page.nodes[i]?.t ?? "", text: page.nodes[i]?.x ?? "" }));
}

/** Handles `/<hex>[/<sub>]` of a scope. Throws HttpError(404) when the route is not one of the page endpoints. */
export async function handlePage(
  deps: PageDeps,
  scope: PageScope,
  req: IncomingMessage,
  res: ServerResponse,
  hex: string,
  sub: string | undefined,
  url: URL,
): Promise<void> {
  const method = req.method ?? "GET";
  scope.guard(hex);
  if (method === "GET" && sub === "frame") return send(res, 200, readFrame(deps.refOf(hex)), { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": FRAME_CSP });
  const ref = deps.refOf(hex);
  const page = deps.pages.load(ref);
  const store = scope.store;

  if (method === "GET" && sub === undefined) {
    const state = store.load(hex, page.nodes.length);
    const mode = effectiveMode(scope, state);
    const { list, chosen } = await draftsFor(deps, page, mode, state, url.searchParams.get("draft"));
    return sendJson(res, 200, {
      hex,
      snapshot_id: page.snapshot.snapshot_id,
      url: page.snapshot.page.final_url,
      title: page.snapshot.page.title ?? "",
      category: page.snapshot.page.category,
      nodes: page.nodes,
      state: { explicit: state.explicit, flags: state.flags, mode, draft: mode === "review" ? state.draft : null },
      seconds: store.secondsByPage().get(hex) ?? 0,
      ...(mode === "review"
        ? { drafts: list.map(({ draft: _d, ...info }) => info), draft: chosen ? { labels_id: chosen.labels_id, labeler_id: chosen.labeler_id, labels: chosen.draft } : null }
        : {}),
    });
  }
  if (method === "PUT" && sub === "state") {
    const body = await readJson(req);
    const wanted = body["mode"];
    if (scope.forcedMode !== null && wanted !== undefined && wanted !== scope.forcedMode) throw new HttpError(409, `the mode of this task is fixed to ${scope.forcedMode}`);
    const saved = store.save(page, { labels: body["labels"], mode: scope.forcedMode ?? wanted, draft: body["draft"], reset: body["reset"] });
    return sendJson(res, 200, { state: { explicit: saved.explicit, flags: saved.flags, mode: saved.mode, draft: saved.draft } });
  }
  if (method === "POST" && sub === "time") {
    const body = await readJson(req);
    return sendJson(res, 200, store.logTime(hex, scope.forcedMode !== null ? { ...body, mode: scope.forcedMode } : body));
  }
  if (method === "POST" && sub === "export") {
    if (!scope.exportable) throw new HttpError(409, "labels made in this task are not exported");
    const r = store.exportPage(page, scope.exportMeta ?? undefined);
    if (r.ok) return sendJson(res, 200, { ok: true, path: r.path, labels_id: r.doc.labels_id, n_labeled: r.doc.coverage.n_labeled });
    return sendJson(res, 409, { ok: false, error: "unlabeled", message: `${r.unlabeled.length} unit(s) of U have no label`, unlabeled: unlabeledReport(page, r.unlabeled), n_unlabeled: r.unlabeled.length });
  }
  throw new HttpError(404, "not found");
}
