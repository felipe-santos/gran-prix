import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isLocked, loadQueues, parseQueue, queuesDir } from "../src/server/queues.js";
import { cleanupTmp, tmpDir } from "./helpers.js";
import { PLAN_A, queueDoc } from "./harness.js";

afterAll(cleanupTmp);

const ID = (c: string): string => `sha256:${c.repeat(64)}`;

describe("label queue format (contract with the labeling-plan lane)", () => {
  it("reads a valid queue of every task", () => {
    for (const [task, mode] of [["prompt-dev", "blind"], ["audit", "blind"], ["retest", "blind"], ["train-sample", "review"], ["test-review", "review"]] as const) {
      const r = parseQueue(queueDoc(task, mode, [ID("a"), ID("b")]), task);
      expect(r.ok, task).toBe(true);
      if (r.ok) expect(r.queue).toMatchObject({ task, mode, plan_sha256: PLAN_A, not_before: null, pages: [{ snapshot_id: ID("a"), split: "train" }, { snapshot_id: ID("b") }] });
    }
    const dated = parseQueue(queueDoc("retest", "blind", [ID("a")], { not_before: "2026-12-05" }));
    expect(dated.ok && dated.queue.not_before).toBe("2026-12-05");
    // a task that is not human-from-scratch may also be blind
    expect(parseQueue(queueDoc("train-sample", "blind", [ID("a")])).ok).toBe(true);
  });

  it("refuses a queue that does not follow the contract, saying why", () => {
    const good = queueDoc("audit", "blind", [ID("a")]);
    const p0 = (good["pages"] as unknown[])[0];
    const bad: Array<[string, unknown, RegExp]> = [
      ["not an object", [1], /JSON object/],
      ["format", { ...good, format: "other" }, /format/],
      ["version", { ...good, format_version: "2.0.0" }, /format_version/],
      ["unknown task", { ...good, task: "calibration" }, /task must be/],
      ["mode", { ...good, mode: "both" }, /mode must be/],
      ["audit in review mode", { ...good, mode: "review" }, /from-scratch.*blind/],
      ["prompt-dev in review mode", { ...good, task: "prompt-dev", mode: "review" }, /blind/],
      ["retest in review mode", { ...good, task: "retest", mode: "review" }, /blind/],
      ["plan hash", { ...good, plan_sha256: "abc" }, /plan_sha256/],
      ["not_before undefined", Object.fromEntries(Object.entries(good).filter(([k]) => k !== "not_before")), /not_before/],
      ["not_before garbage", { ...good, not_before: "next week" }, /not_before/],
      ["empty pages", { ...good, pages: [] }, /non-empty/],
      ["page id", { ...good, pages: [{ snapshot_id: "sha256:zz", url: "u", category: "c", split: "train" }] }, /snapshot_id/],
      ["page url", { ...good, pages: [{ snapshot_id: ID("a"), url: "", category: "c", split: "train" }] }, /url/],
      ["page split", { ...good, pages: [{ snapshot_id: ID("a"), url: "u", category: "c", split: "dev" }] }, /split/],
      ["duplicate page", { ...good, pages: [p0, p0] }, /twice/],
    ];
    for (const [name, doc, why] of bad) {
      const r = parseQueue(doc);
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(r.error, name).toMatch(why);
    }
  });

  it("the file name is the task name", () => {
    const r = parseQueue(queueDoc("audit", "blind", [ID("a")]), "retest");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/file name/);
  });

  it("loadQueues returns the valid queues and lists the invalid files with the reason; a missing dir is no queues", () => {
    const dir = tmpDir("gp-studio-queues-");
    expect(loadQueues(queuesDir(dir))).toEqual({ queues: [], invalid: [] });
    mkdirSync(queuesDir(dir), { recursive: true });
    writeFileSync(join(queuesDir(dir), "audit.json"), JSON.stringify(queueDoc("audit", "blind", [ID("a")])));
    writeFileSync(join(queuesDir(dir), "retest.json"), "{ not json");
    writeFileSync(join(queuesDir(dir), "prompt-dev.json"), JSON.stringify(queueDoc("audit", "blind", [ID("a")])));
    writeFileSync(join(queuesDir(dir), "notes.txt"), "ignored");
    const r = loadQueues(queuesDir(dir));
    expect(r.queues.map((q) => q.task)).toEqual(["audit"]);
    expect(r.invalid.map((i) => i.file)).toEqual(["prompt-dev.json", "retest.json"]);
    expect(r.invalid[0]?.error).toMatch(/file name/);
    expect(r.invalid[1]?.error).toMatch(/not valid JSON/);
  });

  it("not_before: locked while in the future, open at the instant and after, never locked when null", () => {
    const now = new Date("2026-12-05T00:00:00Z");
    expect(isLocked(null, now)).toBe(false);
    expect(isLocked("2026-12-05T00:00:01Z", now)).toBe(true);
    expect(isLocked("2026-12-05T00:00:00Z", now)).toBe(false);
    expect(isLocked("2026-12-05", now)).toBe(false); // a date alone is midnight UTC
    expect(isLocked("2026-12-06", now)).toBe(true);
  });
});
