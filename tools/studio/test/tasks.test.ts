import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validate, type NodeLabels } from "@gran-prix/contracts";
import { buildNodeLabels } from "@gran-prix/labels";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RunningStudio } from "../src/server/app.js";
import { cleanupTmp } from "./helpers.js";
import { corpusIds, PLAN_A, PLAN_B, queueDoc, startOn, type Api, type Harness } from "./harness.js";

afterAll(cleanupTmp);
const running: RunningStudio[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

const start = (over: Parameters<typeof startOn>[1] = {}): Promise<Harness> => startOn("corpusDataDir", over, running);
const hexOf = (id: string): string => id.replace("sha256:", "");
let A: string; // snapshot ids of the two pages of the corpus: article-1 and product-2
let B: string;
let HA: string;
let HB: string;
beforeAll(() => {
  [A, B] = corpusIds() as [string, string];
  HA = hexOf(A);
  HB = hexOf(B);
});

/** Labels every unit of U of a page of a task (the root labeled with one class covers the whole tree). */
async function labelAll(api: Api, task: string, hex: string, cls = "support"): Promise<void> {
  const r = await api("PUT", `/api/tasks/${task}/pages/${hex}/state`, { labels: { explicit: { 0: cls }, flags: {} } });
  expect(r.status, r.text).toBe(200);
}

/** A NodeLabelsSet artifact with an LLM draft of a page: what the blind tasks must never reveal. */
function addLlmDraft(dataDir: string, snapshotId: string, units: number[]): NodeLabels {
  const doc = buildNodeLabels({
    snapshot_id: snapshotId as `sha256:${string}`,
    labeler: { id: "test-llm@1", kind: "llm", params: {} },
    items: units.map((unit_id) => ({ unit_id, y: 0, confidence: 0.8, source: "llm" as const })),
    n_candidates: units.length,
  }) as NodeLabels;
  const dir = join(dataDir, "artifacts", `sha256-${"cd".repeat(32)}`);
  mkdirSync(join(dir, "files", "labels"), { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ kind: "files", type: "NodeLabelsSet" }));
  writeFileSync(join(dir, "files", "labels", `${hexOf(snapshotId).slice(0, 12)}.json`), JSON.stringify(doc));
  return doc;
}

const unitsOf = async (api: Api, task: string, hex: string): Promise<number[]> =>
  ((await api("GET", `/api/tasks/${task}/pages/${hex}`)).json["nodes"] as Array<{ u: number }>).flatMap((n, i) => (n.u !== 0 ? [i] : []));

describe("task list: progress, time, next page", () => {
  it("lists the queues with done/total, accumulated time and the next page; invalid files are reported, not opened", async () => {
    const h = await start({ now: () => new Date("2026-12-01T00:00:00Z") });
    h.queue("audit", queueDoc("audit", "blind", [A, B]));
    h.queue("retest", queueDoc("retest", "blind", [A], { not_before: "2026-12-08T00:00:00Z", plan_sha256: PLAN_B }));
    h.queue("prompt-dev", { ...queueDoc("prompt-dev", "blind", [A]), mode: "review" }); // a from-scratch task cannot be reviewed
    const r = await h.api("GET", "/api/tasks");
    expect(r.status).toBe(200);
    expect(r.json["invalid"]).toEqual([{ file: "prompt-dev.json", error: expect.stringMatching(/blind/) }]);
    const by = Object.fromEntries((r.json["tasks"] as Array<Record<string, any>>).map((t) => [t["id"], t]));
    expect(Object.keys(by).sort()).toEqual(["audit", "calibration", "retest"]);
    expect(by["audit"]).toMatchObject({ kind: "queue", mode: "blind", plan_sha256: PLAN_A, total: 2, done: 0, seconds: 0, locked: false, missing: 0 });
    expect(by["audit"].next).toMatchObject({ hex: HA, category: "article" });
    expect(by["retest"]).toMatchObject({ mode: "blind", locked: true, not_before: "2026-12-08T00:00:00Z", plan_sha256: PLAN_B, total: 1, next: null });
    expect(by["calibration"]).toMatchObject({ kind: "calibration", mode: "blind", total: 12, done: 0, plan_sha256: null });
    // an invalid queue is not a task: it cannot be opened
    expect((await h.api("GET", "/api/tasks/prompt-dev")).status).toBe(404);

    // label the first page: progress and next page move on; time accumulates per task
    await labelAll(h.api, "audit", HA);
    const t = (s: number) => ({ mode: "blind", start: "2026-12-01T10:00:00Z", end: new Date(Date.parse("2026-12-01T10:00:00Z") + s * 1000).toISOString(), seconds: s });
    expect((await h.api("POST", `/api/tasks/audit/pages/${HA}/time`, t(40))).status).toBe(200);
    expect((await h.api("POST", `/api/tasks/audit/pages/${HB}/time`, t(25))).status).toBe(200);
    const after = ((await h.api("GET", "/api/tasks")).json["tasks"] as Array<Record<string, any>>).find((x) => x["id"] === "audit")!;
    expect(after).toMatchObject({ done: 1, total: 2, seconds: 65 });
    expect(after["next"]).toMatchObject({ hex: HB });
    const detail = (await h.api("GET", "/api/tasks/audit")).json;
    expect(detail["pages"].map((p: any) => [p.hex, p.complete, p.seconds, p.split])).toEqual([[HA, true, 40, "train"], [HB, false, 25, "train"]]);
    // the time lives in the task's own log, not in the free-mode one
    expect(existsSync(join(h.dataDir, "human-labels", "ana", "tasks", "audit", "timelog.jsonl"))).toBe(true);
    expect(existsSync(join(h.dataDir, "human-labels", "ana", "timelog.jsonl"))).toBe(false);
  });

  it("a queue page that is not in the data dir counts as missing, never as done", async () => {
    const h = await start();
    h.queue("audit", queueDoc("audit", "blind", [A, `sha256:${"9".repeat(64)}`]));
    const t = ((await h.api("GET", "/api/tasks")).json["tasks"] as Array<Record<string, any>>).find((x) => x["id"] === "audit")!;
    expect(t).toMatchObject({ total: 2, done: 0, missing: 1 });
    const d = (await h.api("GET", "/api/tasks/audit")).json;
    expect(d["pages"][1]).toMatchObject({ missing: true });
    expect((await h.api("GET", `/api/tasks/audit/pages/${"9".repeat(64)}`)).status).toBe(404);
  });

  it("serves only the pages of the task and only valid task ids", async () => {
    const h = await start();
    h.queue("retest", queueDoc("retest", "blind", [A]));
    expect((await h.api("GET", `/api/tasks/retest/pages/${HB}`)).status).toBe(404); // in the data dir, not in the queue
    for (const p of ["/api/tasks/..%2f..%2fx", "/api/tasks/nope", "/api/tasks/RETEST", `/api/tasks/retest/pages/abc`, "/api/tasks/retest/pages/%2e%2e/frame"]) expect((await h.api("GET", p)).status, p).toBe(404);
  });
});

describe("blind tasks: the server never shows a draft, a vote or an LLM label", () => {
  it("a blind task returns no draft even when an LLM draft exists, ignores ?draft= and refuses to switch to review", async () => {
    const h = await start();
    h.queue("audit", queueDoc("audit", "blind", [A]));
    const units = await unitsOf(h.api, "audit", HA);
    const draft = addLlmDraft(h.dataDir, A, units);
    await h.api("GET", "/api/tasks"); // a listing refreshes the index of stored drafts: the draft is known to the server
    const page = await h.api("GET", `/api/tasks/audit/pages/${HA}`);
    expect(page.json["state"]).toMatchObject({ mode: "blind", draft: null, explicit: {} });
    expect(page.json).not.toHaveProperty("draft");
    expect(page.json).not.toHaveProperty("drafts");
    for (const url of [`/api/tasks/audit/pages/${HA}`, `/api/tasks/audit/pages/${HA}?draft=${encodeURIComponent(draft.labels_id)}`, `/api/tasks/audit`, `/api/tasks`]) {
      const r = await h.api("GET", url);
      expect(r.text, url).not.toMatch(/test-llm|readability|llm@|labeler|votes?_/i);
    }
    // the client cannot switch the page to review, nor smuggle a draft reference in
    const sw = await h.api("PUT", `/api/tasks/audit/pages/${HA}/state`, { labels: {}, mode: "review", draft: { labels_id: draft.labels_id, labeler_id: "test-llm@1" } });
    expect(sw.status).toBe(409);
    const ok = await h.api("PUT", `/api/tasks/audit/pages/${HA}/state`, { labels: { explicit: { 0: "noise" }, flags: {} }, mode: "blind", draft: { labels_id: draft.labels_id, labeler_id: "test-llm@1" } });
    expect(ok.status).toBe(200);
    expect(ok.json["state"].draft).toBeNull();
    expect(readFileSync(join(h.dataDir, "human-labels", "ana", "tasks", "audit", `${HA}.json`), "utf8")).not.toContain("test-llm");
    // the exported labels record a blind labeling with no draft
    const ex = await h.api("POST", `/api/tasks/audit/pages/${HA}/export`, {});
    expect(ex.status).toBe(200);
    const doc = JSON.parse(readFileSync(ex.json["path"], "utf8")) as Record<string, any>;
    expect(doc["studio"]).toMatchObject({ mode: "blind", draft: null });
  });

  it("the pages of a blind queue are not served in the free mode (no draft can reach them through the old route)", async () => {
    const h = await start({ defaultMode: "review" });
    h.queue("audit", queueDoc("audit", "blind", [A]));
    addLlmDraft(h.dataDir, A, await unitsOf(h.api, "audit", HA));
    expect((await h.api("GET", `/api/pages/${HA}`)).status).toBe(403);
    expect((await h.api("GET", `/api/pages/${HA}/frame`)).status).toBe(403);
    expect((await h.api("PUT", `/api/pages/${HA}/state`, { labels: {}, mode: "review" })).status).toBe(403);
    expect((await h.api("POST", `/api/pages/${HA}/export`, {})).status).toBe(403);
    const list = await h.api("GET", "/api/pages");
    expect(list.json["pages"].map((p: any) => p.hex)).toEqual([HB]); // the other page is still free
    // "export all" of the free mode does not touch the blind task's pages either
    const all = await h.api("POST", "/api/export", {});
    expect([...all.json["exported"], ...all.json["refused"].map((x: any) => x.hex)]).toEqual([HB]);
    // a page that is free (not in any blind queue) still gets its draft in review mode
    const free = await h.api("GET", `/api/pages/${HB}`);
    expect(free.json["state"].mode).toBe("review");
    expect(free.json["draft"]).toBeTruthy();
  });

  it("a review task shows the draft; its mode cannot be changed, and a page of a blind task cannot be reviewed", async () => {
    const h = await start();
    h.queue("test-review", queueDoc("test-review", "review", [B]));
    addLlmDraft(h.dataDir, B, await unitsOf(h.api, "test-review", HB));
    await h.api("GET", "/api/tasks/test-review"); // a listing refreshes the index of stored drafts
    const page = await h.api("GET", `/api/tasks/test-review/pages/${HB}`);
    expect(page.json["state"].mode).toBe("review");
    expect(page.json["draft"]).toMatchObject({ labeler_id: "test-llm@1" });
    expect((await h.api("PUT", `/api/tasks/test-review/pages/${HB}/state`, { labels: {}, mode: "blind" })).status).toBe(409);
    // an audit queue that also holds the page makes the review of it a conflict: no draft for a page of a blind task
    h.queue("audit", queueDoc("audit", "blind", [B]));
    const conflict = await h.api("GET", `/api/tasks/test-review/pages/${HB}`);
    expect(conflict.status).toBe(409);
    expect(conflict.text).not.toContain("test-llm");
    expect((await h.api("GET", `/api/tasks/test-review/pages/${HB}/frame`)).status).toBe(409);
    const d = (await h.api("GET", "/api/tasks/test-review")).json;
    expect(d["pages"][0]).toMatchObject({ hex: HB, conflict: expect.stringContaining("audit") });
    const summary = ((await h.api("GET", "/api/tasks")).json["tasks"] as Array<Record<string, any>>).find((x) => x["id"] === "test-review")!;
    expect(summary).toMatchObject({ conflicts: 1, done: 0, next: null });
  });

  it("the time log of a blind task records blind whatever the client says", async () => {
    const h = await start();
    h.queue("audit", queueDoc("audit", "blind", [A]));
    const r = await h.api("POST", `/api/tasks/audit/pages/${HA}/time`, { mode: "review", start: "2026-12-01T10:00:00Z", end: "2026-12-01T10:01:00Z", seconds: 30 });
    expect(r.json).toMatchObject({ mode: "blind", seconds: 30 });
  });
});

describe("retest: not_before and the first label stays hidden", () => {
  it("refuses every route of the task before not_before and opens at the instant", async () => {
    let clock = new Date("2026-12-04T23:59:59Z");
    const h = await start({ now: () => clock });
    h.queue("retest", queueDoc("retest", "blind", [A], { not_before: "2026-12-05T00:00:00Z" }));
    const routes: Array<[string, string, unknown?]> = [
      ["GET", "/api/tasks/retest"],
      ["GET", `/api/tasks/retest/pages/${HA}`],
      ["GET", `/api/tasks/retest/pages/${HA}/frame`],
      ["PUT", `/api/tasks/retest/pages/${HA}/state`, { labels: {} }],
      ["POST", `/api/tasks/retest/pages/${HA}/time`, { mode: "blind", start: "2026-12-05T10:00:00Z", end: "2026-12-05T10:00:10Z", seconds: 5 }],
      ["POST", `/api/tasks/retest/pages/${HA}/export`, {}],
      ["POST", "/api/tasks/retest/export", {}],
    ];
    for (const [m, p, b] of routes) {
      const r = await h.api(m, p, b);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.json["error"], p).toMatch(/2026-12-05/);
    }
    const listed = ((await h.api("GET", "/api/tasks")).json["tasks"] as Array<Record<string, any>>).find((x) => x["id"] === "retest")!;
    expect(listed).toMatchObject({ locked: true, not_before: "2026-12-05T00:00:00Z", next: null });
    expect(existsSync(join(h.dataDir, "human-labels"))).toBe(false); // the refusals wrote nothing
    clock = new Date("2026-12-05T00:00:00Z");
    for (const [m, p] of routes.slice(0, 3)) expect((await h.api(m, p)).status, `${m} ${p}`).toBe(200);
    const open = ((await h.api("GET", "/api/tasks")).json["tasks"] as Array<Record<string, any>>).find((x) => x["id"] === "retest")!;
    expect(open).toMatchObject({ locked: false, next: { hex: HA } });
  });

  it("the retest of a page starts empty, never shows the first label, and exports under its own task", async () => {
    const h = await start({ now: () => new Date("2026-12-20T00:00:00Z") });
    h.queue("audit", queueDoc("audit", "blind", [A]));
    h.queue("retest", queueDoc("retest", "blind", [A], { not_before: "2026-12-05T00:00:00Z", plan_sha256: PLAN_B }));
    const units = await unitsOf(h.api, "audit", HA);
    // first labeling (audit): the root is main, one unit is an explicit exception with a doubt flag
    const first = units[1] as number;
    expect((await h.api("PUT", `/api/tasks/audit/pages/${HA}/state`, { labels: { explicit: { 0: "main", [first]: "noise" }, flags: { [first]: ["doubt"] } } })).status).toBe(200);
    const exA = await h.api("POST", `/api/tasks/audit/pages/${HA}/export`, {});
    expect(exA.status).toBe(200);
    // even the audit's export, loaded as a NodeLabelsSet artifact, is no draft for the retest
    const auditDoc = JSON.parse(readFileSync(exA.json["path"], "utf8")) as NodeLabels;
    const dir = join(h.dataDir, "artifacts", `sha256-${"ef".repeat(32)}`);
    mkdirSync(join(dir, "files", "labels"), { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ kind: "files", type: "NodeLabelsSet" }));
    writeFileSync(join(dir, "files", "labels", "first.json"), JSON.stringify(auditDoc));

    const retest = await h.api("GET", `/api/tasks/retest/pages/${HA}`);
    expect(retest.status).toBe(200);
    expect(retest.json["state"]).toEqual({ explicit: {}, flags: {}, mode: "blind", draft: null });
    expect(retest.json).not.toHaveProperty("draft");
    expect(retest.json).not.toHaveProperty("drafts");
    expect(retest.text).not.toContain("human@ana");
    const row = (await h.api("GET", "/api/tasks/retest")).json["pages"][0];
    expect(row).toMatchObject({ hex: HA, labeled: 0, complete: false, exported: false, seconds: 0 });
    // the free route is closed for the page as well: that is where a first label made in free mode would leak from
    expect((await h.api("GET", `/api/pages/${HA}`)).status).toBe(403);

    // the second labeling is its own file, its own export, its own provenance
    await labelAll(h.api, "retest", HA, "main");
    const exB = await h.api("POST", `/api/tasks/retest/pages/${HA}/export`, {});
    expect(exB.status).toBe(200);
    expect(exB.json["path"]).toContain(join("tasks", "retest", "export", "labels"));
    expect(exA.json["path"]).toContain(join("tasks", "audit", "export", "labels"));
    const retestDoc = JSON.parse(readFileSync(exB.json["path"], "utf8")) as NodeLabels & Record<string, any>;
    expect(retestDoc["studio"]).toMatchObject({ task: "retest", plan_sha256: PLAN_B, mode: "blind" });
    expect(auditDoc["studio" as keyof NodeLabels]).toMatchObject({ task: "audit", plan_sha256: PLAN_A });
    expect(retestDoc.labels_id).not.toBe(auditDoc.labels_id);
    expect(JSON.parse(readFileSync(join(h.dataDir, "human-labels", "ana", "tasks", "audit", `${HA}.json`), "utf8")).explicit).toMatchObject({ 0: "main", [first]: "noise" }); // the first one is untouched
  });
});

describe("export per task carries the task and the plan", () => {
  it("writes task and plan_sha256 into the open `studio` block of contract-valid NodeLabels", async () => {
    const h = await start();
    h.queue("audit", queueDoc("audit", "blind", [A, B]));
    await labelAll(h.api, "audit", HA, "main");
    const r = await h.api("POST", "/api/tasks/audit/export", {});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ task: "audit", plan_sha256: PLAN_A, exported: [HA] });
    expect(r.json["refused"]).toEqual([{ hex: HB, unlabeled: expect.any(Number) }]);
    const file = join(h.dataDir, "human-labels", "ana", "tasks", "audit", "export", "labels", `${HA.slice(0, 12)}.json`);
    const doc = JSON.parse(readFileSync(file, "utf8")) as NodeLabels & Record<string, any>;
    expect(validate("node-labels", doc).issues).toEqual([]);
    expect(doc.labeler).toMatchObject({ id: "human@ana", kind: "human" });
    expect(doc["studio"]).toMatchObject({ task: "audit", plan_sha256: PLAN_A, mode: "blind", draft: null });
    expect(existsSync(join(h.dataDir, "human-labels", "ana", "export"))).toBe(false); // nothing in the free-mode export dir
    // exporting again is stable; a different plan hash gives a different labels_id for the same labels
    expect(((await h.api("POST", `/api/tasks/audit/pages/${HA}/export`, {})).json as Record<string, any>)["labels_id"]).toBe(doc.labels_id);
    h.queue("audit", queueDoc("audit", "blind", [A, B], { plan_sha256: PLAN_B }));
    const again = await h.api("POST", `/api/tasks/audit/pages/${HA}/export`, {});
    expect(again.json["labels_id"]).not.toBe(doc.labels_id);
    expect(JSON.parse(readFileSync(file, "utf8"))["studio"].plan_sha256).toBe(PLAN_B);
  });

  it("the free mode keeps exporting without task provenance", async () => {
    const h = await start();
    await h.api("PUT", `/api/pages/${HB}/state`, { labels: { explicit: { 0: "support" }, flags: {} } });
    const r = await h.api("POST", `/api/pages/${HB}/export`, {});
    const doc = JSON.parse(readFileSync(r.json["path"], "utf8")) as Record<string, any>;
    expect(doc["studio"]).not.toHaveProperty("task");
    expect(doc["studio"]).not.toHaveProperty("plan_sha256");
  });
});
