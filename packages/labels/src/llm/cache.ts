import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BlockAnswer, LlmUsage } from "./types.js";

/**
 * Content-hash response cache. The key is `llmCacheKey({provider, model, promptSha256, inputSha256, params,
 * outputContract})` of `@gran-prix/contracts`: it depends on the exact text sent, never on a run id, a clock or a
 * file name, so a re-run (or another pipeline asking the same question) never pays twice. A record holds what
 * the paid call(s) produced, including a FAILED outcome: temperature 0 would fail again, so a failure is not
 * paid for twice either (`retry_failed` bypasses it on purpose). `pending_retry` = the first answer was paid and
 * rejected, and the retry has not happened yet (budget or network stopped it): a re-run resumes at the retry.
 */

export const CACHE_RECORD_FORMAT = "gran-prix.llm-response-cache" as const;

export interface CacheRecord {
  format: typeof CACHE_RECORD_FORMAT;
  key: string;
  status: "ok" | "failed" | "pending_retry";
  /** Validated answers of an `ok` record (for `on_missing: "leave_unlabeled"` a failed-missing record keeps its valid ones). */
  answers: BlockAnswer[];
  /** Asked ids still unanswered after the retry (only with `status: "ok"` under `leave_unlabeled`). */
  missing: string[];
  /** Calls made for this chunk (1, or 2 with the bounded retry). */
  attempts: number;
  /** Token usage summed over the attempts, as the API reported it. */
  usage: LlmUsage;
  /** Why a `failed` record failed. */
  error?: string;
  /** Raw text of the last response (ids and classes only; never the key, never page text). */
  raw: string;
}

export interface LlmResponseCache {
  get(key: string): CacheRecord | undefined;
  put(record: CacheRecord): void;
}

export class MemoryLlmCache implements LlmResponseCache {
  readonly records = new Map<string, CacheRecord>();
  get(key: string): CacheRecord | undefined {
    return this.records.get(key);
  }
  put(record: CacheRecord): void {
    this.records.set(record.key, record);
  }
}

/** One JSON file per key under `dir`, written atomically (temp file + rename). */
export class FsLlmCache implements LlmResponseCache {
  constructor(readonly dir: string) {}

  private file(key: string): string {
    return join(this.dir, `${key.replace(/^sha256:/, "")}.json`);
  }

  get(key: string): CacheRecord | undefined {
    const f = this.file(key);
    if (!existsSync(f)) return undefined;
    const rec = JSON.parse(readFileSync(f, "utf8")) as CacheRecord;
    return rec.format === CACHE_RECORD_FORMAT && rec.key === key ? rec : undefined;
  }

  put(record: CacheRecord): void {
    const f = this.file(record.key);
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record)}\n`);
    renameSync(tmp, f);
  }
}
