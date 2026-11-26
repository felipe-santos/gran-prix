import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Mode } from "../core/types.js";

/**
 * Label queues: `<data-dir>/labeling/queues/<task>.json`, written by the labeling-plan lane (L4f) and read here.
 * The format is a contract between the two lanes and must not change:
 *
 *   {"format":"gran-prix.label-queue","format_version":"1.0.0","task":"prompt-dev|audit|retest|train-sample|test-review",
 *    "mode":"blind|review","plan_sha256":"sha256:...","not_before":null|"<ISO date>",
 *    "pages":[{"snapshot_id":"sha256:...","url":"...","category":"...","split":"train|val|test"}]}
 *
 * The reading is strict: a file that does not follow the contract is NOT a task (it is listed as invalid, with the
 * reason, and never opened). Besides the shape, two rules of the protocol (experimento-dom-v0, 5.1) are enforced here,
 * because a queue that breaks them would break the blindness of the experiment:
 *  - `prompt-dev`, `audit` and `retest` are human-from-scratch tasks: their mode must be `blind`;
 *  - the file name is the task name (`audit.json` holds `"task":"audit"`), so a task has exactly one queue.
 */

export const QUEUE_FORMAT = "gran-prix.label-queue";
export const QUEUE_TASKS = ["prompt-dev", "audit", "retest", "train-sample", "test-review"] as const;
export type QueueTask = (typeof QUEUE_TASKS)[number];
export const BLIND_ONLY_TASKS: readonly QueueTask[] = ["prompt-dev", "audit", "retest"];
export const SPLITS = ["train", "val", "test"] as const;

export interface QueuePage {
  snapshot_id: string;
  url: string;
  category: string;
  split: (typeof SPLITS)[number];
}

export interface LabelQueue {
  task: QueueTask;
  mode: Mode;
  plan_sha256: string;
  /** ISO date or timestamp; the task cannot be opened before it. `null`: no restriction. */
  not_before: string | null;
  pages: QueuePage[];
}

export interface InvalidQueue {
  file: string;
  error: string;
}

const SHA_RE = /^sha256:[0-9a-f]{64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export type ParsedQueue = { ok: true; queue: LabelQueue } | { ok: false; error: string };

/** Validates a queue document. `stem` is the file name without `.json`, when it comes from a file. */
export function parseQueue(raw: unknown, stem?: string): ParsedQueue {
  const fail = (error: string): ParsedQueue => ({ ok: false, error });
  if (!isObj(raw)) return fail("not a JSON object");
  if (raw["format"] !== QUEUE_FORMAT) return fail(`format must be ${JSON.stringify(QUEUE_FORMAT)}`);
  if (typeof raw["format_version"] !== "string" || !/^1\.\d+\.\d+$/.test(raw["format_version"])) return fail("format_version must be 1.x.y");
  const task = raw["task"];
  if (typeof task !== "string" || !(QUEUE_TASKS as readonly string[]).includes(task)) return fail(`task must be one of ${QUEUE_TASKS.join(", ")}`);
  if (stem !== undefined && stem !== task) return fail(`the file name (${stem}.json) must be the task name (${task}.json)`);
  const mode = raw["mode"];
  if (mode !== "blind" && mode !== "review") return fail('mode must be "blind" or "review"');
  if (mode !== "blind" && (BLIND_ONLY_TASKS as readonly string[]).includes(task)) return fail(`task ${task} is human-from-scratch: its mode must be "blind" (protocol 5.1)`);
  const plan = raw["plan_sha256"];
  if (typeof plan !== "string" || !SHA_RE.test(plan)) return fail("plan_sha256 must be sha256:<64 hex>");
  const nb = raw["not_before"];
  if (nb !== null && (typeof nb !== "string" || !Number.isFinite(Date.parse(nb)))) return fail("not_before must be null or an ISO date");
  // Protocol 5.4: the retest is done >= 7 days after the audit, blind to the first labels. A retest queue without a
  // date would open at once, so it is refused (the plan writes the date).
  if (task === "retest" && nb === null) return fail("a retest queue needs not_before (protocol 5.4: >= 7 days after the audit)");
  const pages = raw["pages"];
  if (!Array.isArray(pages) || pages.length === 0) return fail("pages must be a non-empty array");
  const seen = new Set<string>();
  const out: QueuePage[] = [];
  for (const [i, p] of pages.entries()) {
    if (!isObj(p)) return fail(`pages[${i}] is not an object`);
    const { snapshot_id, url, category, split } = p;
    if (typeof snapshot_id !== "string" || !SHA_RE.test(snapshot_id)) return fail(`pages[${i}].snapshot_id must be sha256:<64 hex>`);
    if (typeof url !== "string" || url === "") return fail(`pages[${i}].url must be a non-empty string`);
    if (typeof category !== "string" || category === "") return fail(`pages[${i}].category must be a non-empty string`);
    if (typeof split !== "string" || !(SPLITS as readonly string[]).includes(split)) return fail(`pages[${i}].split must be one of ${SPLITS.join(", ")}`);
    if (seen.has(snapshot_id)) return fail(`pages[${i}]: snapshot ${snapshot_id.slice(0, 19)}... appears twice`);
    seen.add(snapshot_id);
    out.push({ snapshot_id, url, category, split: split as QueuePage["split"] });
  }
  return { ok: true, queue: { task: task as QueueTask, mode, plan_sha256: plan, not_before: nb as string | null, pages: out } };
}

/** Where the queues are unless `--queues-dir` says otherwise: `<data-dir>/labeling/queues`. */
export const queuesDir = (dataDir: string): string => join(dataDir, "labeling", "queues");

/** Every `*.json` of a queues dir: the valid ones as queues, the others as invalid with the reason. A missing dir is no queues. */
export function loadQueues(dir: string): { queues: LabelQueue[]; invalid: InvalidQueue[] } {
  const queues: LabelQueue[] = [];
  const invalid: InvalidQueue[] = [];
  if (!existsSync(dir)) return { queues, invalid };
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch (e) {
      invalid.push({ file: name, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    const r = parseQueue(raw, name.slice(0, -".json".length));
    if (r.ok) queues.push(r.queue);
    else invalid.push({ file: name, error: r.error });
  }
  return { queues, invalid };
}

/** True while `not_before` is in the future. */
export const isLocked = (notBefore: string | null, now: Date): boolean => notBefore !== null && Date.parse(notBefore) > now.getTime();
