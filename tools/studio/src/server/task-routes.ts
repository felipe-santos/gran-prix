import type { IncomingMessage, ServerResponse } from "node:http";
import type { Mode } from "../core/types.js";
import { CALIBRATION_CRITERION } from "../core/calibration.js";
import { Calibration, CALIBRATION_TASK } from "./calibration.js";
import { HttpError, sendJson } from "./http.js";
import { HumanStore, TASK_ID_RE } from "./human-store.js";
import { handlePage, pageRow, type PageDeps, type PageScope } from "./page-routes.js";
import { isLocked, loadQueues, type InvalidQueue, type LabelQueue } from "./queues.js";
import { isHex, listPages, type PageRef } from "./snapshot-set.js";

/**
 * Tasks: the queues of the labeling plan (`<data-dir>/labeling/queues/<task>.json`) and the built-in calibration
 * exercise. A task fixes the mode of its pages (a blind task never gets a draft, an extractor vote or an LLM label from
 * this server), owns a private label store (`human-labels/<annotator>/tasks/<task>/`), refuses to open before its
 * `not_before`, and exports with its `task` and `plan_sha256` in the provenance.
 */

export interface TaskPageDef {
  hex: string;
  snapshot_id: string;
  url: string;
  category: string;
  split: string | null;
  /** `null`: the snapshot of the queue is not in this data dir (not collected yet). */
  ref: PageRef | null;
}

export interface TaskDef {
  id: string;
  kind: "queue" | "calibration";
  mode: Mode;
  plan_sha256: string | null;
  not_before: string | null;
  pages: TaskPageDef[];
}

export interface TaskOptions {
  dataDir: string;
  /** Directory of the queue files. */
  queuesDir: string;
  annotator: string;
  now: () => Date;
  deps: PageDeps;
  calibration: Calibration;
}

const hexOf = (snapshotId: string): string => snapshotId.replace(/^sha256:/, "");

export class Tasks {
  private readonly stores = new Map<string, HumanStore>();

  constructor(private readonly o: TaskOptions) {}

  storeFor(id: string, mode: Mode): HumanStore {
    let s = this.stores.get(id);
    if (!s) {
      s = new HumanStore(this.o.dataDir, this.o.annotator, mode, id);
      this.stores.set(id, s);
    }
    return s;
  }

  /** Reads the queue files again on every call, so a queue written while the Studio runs shows up. */
  scan(): { tasks: TaskDef[]; invalid: InvalidQueue[] } {
    const { queues, invalid } = loadQueues(this.o.queuesDir);
    const refs = new Map(listPages(this.o.dataDir).map((r) => [r.hex, r]));
    const queueTasks = queues.map((q): TaskDef => this.fromQueue(q, refs));
    const calPages = this.o.calibration.pages();
    const cal: TaskDef = {
      id: CALIBRATION_TASK,
      kind: "calibration",
      mode: "blind",
      plan_sha256: null,
      not_before: null,
      pages: calPages.map((ref) => ({ hex: ref.hex, snapshot_id: ref.entry.snapshot_id, url: ref.entry.url, category: ref.entry.stratum, split: null, ref })),
    };
    return { tasks: [cal, ...queueTasks], invalid };
  }

  private fromQueue(q: LabelQueue, refs: Map<string, PageRef>): TaskDef {
    return {
      id: q.task,
      kind: "queue",
      mode: q.mode,
      plan_sha256: q.plan_sha256,
      not_before: q.not_before,
      pages: q.pages.map((p) => ({ hex: hexOf(p.snapshot_id), snapshot_id: p.snapshot_id, url: p.url, category: p.category, split: p.split, ref: refs.get(hexOf(p.snapshot_id)) ?? null })),
    };
  }

  get(id: string): TaskDef | null {
    return this.scan().tasks.find((t) => t.id === id) ?? null;
  }

  /** Pages of the BLIND queue tasks, with the task that owns them: they are served only inside it. */
  blindQueuePages(): Map<string, string> {
    const out = new Map<string, string>();
    for (const q of loadQueues(this.o.queuesDir).queues) if (q.mode === "blind") for (const p of q.pages) if (!out.has(hexOf(p.snapshot_id))) out.set(hexOf(p.snapshot_id), q.task);
    return out;
  }

  private scopeOf(task: TaskDef): PageScope {
    const blind = this.blindQueuePages();
    return {
      store: this.storeFor(task.id, task.mode),
      forcedMode: task.mode,
      exportMeta: task.kind === "queue" ? { task: task.id, plan_sha256: task.plan_sha256 } : null,
      exportable: task.kind === "queue",
      guard: (hex) => {
        this.assertOpen(task);
        const p = task.pages.find((x) => x.hex === hex);
        if (!p || !p.ref) throw new HttpError(404, "no such page in this task");
        const owner = blind.get(hex);
        if (task.mode === "review" && owner !== undefined) {
          throw new HttpError(409, `page is in the blind task "${owner}": a draft must never be shown for it, so it cannot be reviewed in "${task.id}"`);
        }
      },
    };
  }

  private assertOpen(task: TaskDef): void {
    if (isLocked(task.not_before, this.o.now())) throw new HttpError(403, `task "${task.id}" opens only on or after ${task.not_before}`);
  }

  /** Summary of one task: progress, accumulated time, next page. */
  summary(task: TaskDef): Record<string, unknown> {
    const store = this.storeFor(task.id, task.mode);
    const seconds = store.secondsByPage();
    const locked = isLocked(task.not_before, this.o.now());
    const base = { id: task.id, kind: task.kind, mode: task.mode, plan_sha256: task.plan_sha256, not_before: task.not_before, locked, seconds: store.timelog().reduce((a, e) => a + e.seconds, 0) };
    if (task.kind === "calibration") {
      const s = this.o.calibration.summary();
      const next = this.o.calibration.results().findIndex((r) => r === null) + 1;
      return { ...base, total: CALIBRATION_CRITERION.groups, done: s.finished, available: this.o.calibration.complete(), next: next > 0 ? { group: next } : null, calibration: s };
    }
    const blind = this.blindQueuePages();
    const scope = this.scopeOf(task);
    let done = 0;
    let missing = 0;
    let conflicts = 0;
    let next: Record<string, unknown> | null = null;
    for (const p of task.pages) {
      if (!p.ref) {
        missing++;
        continue;
      }
      if (task.mode === "review" && blind.has(p.hex)) {
        conflicts++;
        continue;
      }
      const row = pageRow(this.o.deps, scope, p.ref, seconds);
      if (row["complete"] === true) done++;
      else if (next === null && !locked) next = { hex: p.hex, url: p.url, category: p.category, title: row["title"] ?? "" };
    }
    return { ...base, total: task.pages.length, done, missing, conflicts, next: locked ? null : next };
  }

  /** `GET|POST /api/tasks...`; `path` is the decoded path. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    if (method === "GET" && path === "/api/tasks") {
      this.o.deps.drafts.refresh(); // new NodeLabelsSet artifacts may have appeared since the last listing
      const { tasks, invalid } = this.scan();
      return sendJson(res, 200, { annotator: this.o.annotator, tasks: tasks.map((t) => this.summary(t)), invalid });
    }
    const m = /^\/api\/tasks\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!m || !TASK_ID_RE.test(m[1] as string)) throw new HttpError(404, "not found");
    const task = this.get(m[1] as string);
    if (!task) throw new HttpError(404, "no such task");
    const rest = m[2] ?? "";

    if (method === "GET" && rest === "") {
      this.assertOpen(task);
      this.o.deps.drafts.refresh();
      const scope = this.scopeOf(task);
      const seconds = scope.store.secondsByPage();
      const blind = this.blindQueuePages();
      const pages = task.pages.map((p) => {
        const meta = { hex: p.hex, url: p.url, category: p.category, split: p.split };
        if (!p.ref) return { ...meta, missing: true };
        if (task.mode === "review" && blind.has(p.hex)) return { ...meta, conflict: `blind task "${blind.get(p.hex)}"` };
        return { ...pageRow(this.o.deps, scope, p.ref, seconds), split: p.split };
      });
      return sendJson(res, 200, { ...this.summary(task), pages });
    }
    if (task.kind === "calibration" && rest === "groups" && method === "GET") {
      this.assertOpen(task);
      return sendJson(res, 200, await this.o.calibration.groups());
    }
    const fin = /^groups\/(\d+)\/finish$/.exec(rest);
    if (task.kind === "calibration" && fin && method === "POST") {
      this.assertOpen(task);
      return sendJson(res, 200, { result: await this.o.calibration.finish(Number(fin[1]), this.o.now()), summary: this.o.calibration.summary() });
    }
    if (method === "POST" && rest === "export") {
      this.assertOpen(task);
      if (task.kind !== "queue") throw new HttpError(409, "labels made in this task are not exported");
      const scope = this.scopeOf(task);
      const exported: string[] = [];
      const refused: Array<{ hex: string; unlabeled: number }> = [];
      const skipped: Array<{ hex: string; reason: string }> = [];
      for (const p of task.pages) {
        try {
          scope.guard(p.hex);
        } catch (e) {
          skipped.push({ hex: p.hex, reason: e instanceof Error ? e.message : String(e) });
          continue;
        }
        const r = scope.store.exportPage(this.o.deps.pages.load(p.ref as PageRef), scope.exportMeta ?? undefined);
        if (r.ok) exported.push(p.hex);
        else refused.push({ hex: p.hex, unlabeled: r.unlabeled.length });
      }
      return sendJson(res, 200, { task: task.id, plan_sha256: task.plan_sha256, exported, refused, skipped });
    }
    const pm = /^pages\/([^/]+)(?:\/([a-z]+))?$/.exec(rest);
    if (pm) {
      if (!isHex(pm[1] as string)) throw new HttpError(404, "no such page");
      return handlePage(this.o.deps, this.scopeOf(task), req, res, pm[1] as string, pm[2], url);
    }
    throw new HttpError(404, "not found");
  }
}
