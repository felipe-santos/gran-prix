import type { Draft } from "../core/labels.js";
import type { LabelState, LightNode, Mode } from "../core/types.js";

/** Client of the Studio server. The session token is injected into the page as <meta name="gp-token"> by the server. */

export const token = (): string => document.querySelector<HTMLMetaElement>('meta[name="gp-token"]')?.content ?? new URLSearchParams(location.search).get("token") ?? "";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, keepalive = false): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: { "x-studio-token": token(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    keepalive,
  });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  if (!r.ok) throw new ApiError(r.status, (json as { error?: string; message?: string } | null)?.message ?? (json as { error?: string } | null)?.error ?? `HTTP ${r.status}`, json);
  return json as T;
}

export interface PageRow {
  hex: string;
  snapshot_id: string;
  url: string;
  category: string;
  node_count: number;
  title?: string;
  units?: number;
  labeled?: number;
  doubt?: number;
  mixed?: number;
  mode?: Mode;
  complete?: boolean;
  exported?: boolean;
  seconds?: number;
  error?: string;
}

export interface DraftInfo {
  labels_id: string;
  labeler_id: string;
  kind: string;
  n: number;
}

export interface PageDoc {
  hex: string;
  snapshot_id: string;
  url: string;
  title: string;
  category: string;
  nodes: LightNode[];
  state: LabelState & { mode: Mode; draft: { labels_id: string; labeler_id: string } | null };
  seconds: number;
  drafts?: DraftInfo[];
  draft?: { labels_id: string; labeler_id: string; labels: Draft } | null;
}

export interface UnlabeledItem {
  unit_id: number;
  tag: string;
  text: string;
}

export type ExportResult =
  | { ok: true; path: string; labels_id: string; n_labeled: number }
  | { ok: false; unlabeled: UnlabeledItem[]; n_unlabeled: number; message: string };

export const api = {
  info: () => call<{ annotator: string; version: string; guide: boolean; data_dir: string }>("GET", "/api/info"),
  pages: () => call<{ annotator: string; pages: PageRow[] }>("GET", "/api/pages"),
  page: (hex: string, draft?: string) => call<PageDoc>("GET", `/api/pages/${hex}${draft ? `?draft=${encodeURIComponent(draft)}` : ""}`),
  save: (hex: string, body: { labels: LabelState; mode?: Mode; draft?: { labels_id: string; labeler_id: string } | null; reset?: boolean }) =>
    call<{ state: PageDoc["state"] }>("PUT", `/api/pages/${hex}/state`, body),
  time: (hex: string, body: { mode: Mode; start: string; end: string; seconds: number }) => call<unknown>("POST", `/api/pages/${hex}/time`, body, true),
  exportPage: async (hex: string): Promise<ExportResult> => {
    try {
      return await call<ExportResult>("POST", `/api/pages/${hex}/export`, {});
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return e.body as ExportResult;
      throw e;
    }
  },
  exportAll: () => call<{ exported: string[]; refused: Array<{ hex: string; unlabeled: number }> }>("POST", "/api/export", {}),
  frameUrl: (hex: string): string => `/api/pages/${hex}/frame?token=${encodeURIComponent(token())}`,
  guideUrl: (): string => `/api/guide?token=${encodeURIComponent(token())}`,
};
