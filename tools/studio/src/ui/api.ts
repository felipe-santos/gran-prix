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

/** The page endpoints of a scope: the free mode (`task` null) or one task. The server fixes the mode of a task's pages. */
export interface PageApi {
  page(hex: string, draft?: string): Promise<PageDoc>;
  save(hex: string, body: { labels: LabelState; mode?: Mode; draft?: { labels_id: string; labeler_id: string } | null; reset?: boolean }): Promise<{ state: PageDoc["state"] }>;
  time(hex: string, body: { mode: Mode; start: string; end: string; seconds: number }): Promise<unknown>;
  exportPage(hex: string): Promise<ExportResult>;
  frameUrl(hex: string): string;
}

export function pageApi(task: string | null): PageApi {
  const base = task === null ? "/api/pages" : `/api/tasks/${task}/pages`;
  return {
    page: (hex, draft) => call<PageDoc>("GET", `${base}/${hex}${draft ? `?draft=${encodeURIComponent(draft)}` : ""}`),
    save: (hex, body) => call("PUT", `${base}/${hex}/state`, body),
    time: (hex, body) => call("POST", `${base}/${hex}/time`, body, true),
    exportPage: async (hex) => {
      try {
        return await call<ExportResult>("POST", `${base}/${hex}/export`, {});
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && (e.body as { error?: string } | null)?.error === "unlabeled") return e.body as ExportResult;
        throw e;
      }
    },
    frameUrl: (hex) => `${base}/${hex}/frame?token=${encodeURIComponent(token())}`,
  };
}

export interface TaskSummary {
  id: string;
  kind: "queue" | "calibration";
  mode: Mode;
  plan_sha256: string | null;
  not_before: string | null;
  locked: boolean;
  total: number;
  done: number;
  seconds: number;
  missing?: number;
  conflicts?: number;
  available?: boolean;
  next: { hex?: string; url?: string; category?: string; title?: string; group?: number } | null;
  calibration?: CalibrationSummary;
}

export interface TaskPageRow extends Partial<PageRow> {
  hex: string;
  url: string;
  category: string;
  split: string | null;
  missing?: boolean;
  conflict?: string;
}

export interface CalibrationSummary {
  total: number;
  finished: number;
  binary_correct: number;
  three_correct: number;
  binary_needed: number;
  three_needed: number;
  passed: boolean | null;
}

export interface CalUnit {
  fixture: string;
  selector: string;
  unit_id: number;
  tag: string;
  text: string;
  expected: string;
  given: string;
  binary_ok: boolean;
  three_ok: boolean;
}

export interface CalResult {
  n: number;
  n_units: number;
  n_outside_targets: number;
  binary_ok: boolean;
  three_ok: boolean;
  binary_errors: number;
  three_errors: number;
  errors: CalUnit[];
}

export interface CalGroup {
  n: number;
  title: string;
  fixtures: string[];
  pages: Array<{ fixture: string; hex: string | null }>;
  targets: Array<{ fixture: string; selector: string; what: string }>;
  available: boolean;
  units_total: number;
  units_labeled: number;
  finished: boolean;
  result?: CalResult;
}

export const api = {
  info: () => call<{ annotator: string; version: string; guide: boolean; data_dir: string }>("GET", "/api/info"),
  pages: () => call<{ annotator: string; pages: PageRow[] }>("GET", "/api/pages"),
  exportAll: () => call<{ exported: string[]; refused: Array<{ hex: string; unlabeled: number }> }>("POST", "/api/export", {}),
  guideUrl: (): string => `/api/guide?token=${encodeURIComponent(token())}`,
  tasks: () => call<{ annotator: string; tasks: TaskSummary[]; invalid: Array<{ file: string; error: string }> }>("GET", "/api/tasks"),
  task: (id: string) => call<TaskSummary & { pages: TaskPageRow[] }>("GET", `/api/tasks/${id}`),
  exportTask: (id: string) => call<{ task: string; plan_sha256: string | null; exported: string[]; refused: Array<{ hex: string; unlabeled: number }>; skipped: Array<{ hex: string; reason: string }> }>("POST", `/api/tasks/${id}/export`, {}),
  calibration: () => call<{ groups: CalGroup[]; summary: CalibrationSummary }>("GET", "/api/tasks/calibration/groups"),
  finishGroup: (n: number) => call<{ result: CalResult; summary: CalibrationSummary }>("POST", `/api/tasks/calibration/groups/${n}/finish`, {}),
};
