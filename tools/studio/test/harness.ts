import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";
import { startStudio, type RunningStudio } from "../src/server/app.js";
import { listPages } from "../src/server/snapshot-set.js";
import { tmpDir } from "./helpers.js";

/** Shared by the task and calibration tests: a Studio over a private copy of a collected data dir, plus a JSON client. */

export const TOKEN = "test-token-0123456789";
export const FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures/pages", import.meta.url));
export const PLAN_A = `sha256:${"a1".repeat(32)}`;
export const PLAN_B = `sha256:${"b2".repeat(32)}`;

export interface Api {
  (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any>; text: string }>;
}

export interface Harness {
  s: RunningStudio;
  dataDir: string;
  api: Api;
  /** Writes `<data-dir>/labeling/queues/<name>.json`. */
  queue(name: string, doc: unknown): void;
}

export async function startOn(source: "corpusDataDir" | "calibrationDataDir", over: Partial<Parameters<typeof startStudio>[0]> = {}, running: RunningStudio[]): Promise<Harness> {
  const dataDir = tmpDir("gp-studio-task-");
  cpSync(inject(source), dataDir, { recursive: true });
  const uiDir = tmpDir("gp-studio-ui-");
  mkdirSync(join(uiDir, "assets"));
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><html><head><title>t</title></head><body>ui</body></html>");
  const s = await startStudio({ dataDir, uiDir, annotator: "ana", token: TOKEN, fixturesDir: FIXTURES_DIR, ...over });
  running.push(s);
  const api: Api = async (method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${s.port}${path}`, {
      method,
      headers: { "x-studio-token": TOKEN, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text) as Record<string, any>;
    } catch {
      /* not json */
    }
    return { status: r.status, json, text };
  };
  return {
    s,
    dataDir,
    api,
    queue: (name, doc) => {
      mkdirSync(join(dataDir, "labeling", "queues"), { recursive: true });
      writeFileSync(join(dataDir, "labeling", "queues", `${name}.json`), JSON.stringify(doc));
    },
  };
}

/** A queue document in the format of the contract with the labeling-plan lane (L4f). */
export function queueDoc(task: string, mode: "blind" | "review", snapshotIds: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "gran-prix.label-queue",
    format_version: "1.0.0",
    task,
    mode,
    plan_sha256: PLAN_A,
    not_before: null,
    pages: snapshotIds.map((id, i) => ({ snapshot_id: id, url: `https://example.test/p${i}`, category: i === 0 ? "article" : "product", split: "train" })),
    ...over,
  };
}

/** Snapshot ids of the two pages of the corpus (article-1, product-2). */
export const corpusIds = (): string[] => listPages(inject("corpusDataDir")).map((p) => p.entry.snapshot_id);
