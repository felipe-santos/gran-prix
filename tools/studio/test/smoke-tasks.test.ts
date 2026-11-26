// Headless-Chromium smoke test of the task screens: the home lists the tasks with progress, a blind queue task is labeled by
// keyboard and exported with its task and plan, and the calibration exercise is done in the labeler and scored.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { validate, type NodeLabels } from "@gran-prix/contracts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { startStudio, type RunningStudio } from "../src/server/app.js";
import { fixtureNameOf } from "../src/server/calibration.js";
import { listPages } from "../src/server/snapshot-set.js";
import { cleanupTmp, findChromium, tmpDir } from "./helpers.js";
import { FIXTURES_DIR, PLAN_A, queueDoc } from "./harness.js";

const uiDir = fileURLToPath(new URL("../dist/ui", import.meta.url));

let studio: RunningStudio;
let dataDir: string;
let browser: Browser;
let auditHex: string;

beforeAll(async () => {
  expect(existsSync(join(uiDir, "index.html")), "the UI must be built (vite build): the global setup does it").toBe(true);
  dataDir = tmpDir("gp-studio-smoke-tasks-");
  cpSync(inject("calibrationDataDir"), dataDir, { recursive: true });
  const refs = listPages(dataDir);
  const article = refs.find((r) => fixtureNameOf(r.entry.url) === "article-1")!;
  const product = refs.find((r) => fixtureNameOf(r.entry.url) === "product-2")!;
  auditHex = article.hex;
  mkdirSync(join(dataDir, "labeling", "queues"), { recursive: true });
  writeFileSync(join(dataDir, "labeling", "queues", "audit.json"), JSON.stringify(queueDoc("audit", "blind", [article.entry.snapshot_id, product.entry.snapshot_id])));
  studio = await startStudio({ dataDir, annotator: "smoke", uiDir, fixturesDir: FIXTURES_DIR });
  browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  cleanupTmp();
});

describe("headless smoke: tasks", () => {
  it("lists the tasks, labels a blind queue task by keyboard and exports it with task and plan", async () => {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(studio.url);
    const rows = page.locator("[data-testid=task-row]");
    await rows.first().waitFor();
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-task")))).toEqual(["calibration", "audit"]);
    const audit = page.locator("[data-testid=task-row][data-task=audit]");
    expect(await audit.locator("[data-testid=task-progress]").textContent()).toBe("0/2");
    expect(await page.locator("[data-testid=task-row][data-task=calibration] [data-testid=task-progress]").textContent()).toBe("0/12");

    await audit.locator("td a").first().click();
    await page.locator("[data-testid=task-view]").waitFor();
    expect(await page.locator("[data-testid=page-row]").count()).toBe(2);
    await page.locator(`[data-testid=page-row][data-hex="${auditHex}"] a`).click();
    await page.locator("[data-testid=page-frame]").waitFor();
    expect(await page.textContent("[data-testid=mode-fixed]")).toContain("cego");
    expect(await page.locator("[data-testid=mode-review]").count()).toBe(0); // no mode switch inside a task
    await page.waitForFunction(() => /\/\d+ labeled/.test(document.querySelector("[data-testid=progress-text]")?.textContent ?? ""));
    const total = Number(/\/(\d+) labeled/.exec((await page.textContent("[data-testid=progress-text]")) ?? "")?.[1]);
    expect(total).toBeGreaterThan(20);
    const fl = page.frameLocator("[data-testid=page-frame]");
    await fl.locator("h1").click();
    await page.keyboard.press("1");
    for (let i = 0; i < total + 5; i++) {
      const done = Number(/(\d+)\/\d+ labeled/.exec((await page.textContent("[data-testid=progress-text]")) ?? "")?.[1]);
      if (done === total) break;
      await page.keyboard.press("3");
    }
    await page.waitForFunction(() => document.querySelector("[data-testid=save-status]")?.textContent === "saved");
    await page.keyboard.press("e");
    await page.locator("[data-testid=export-result][data-ok=true]").waitFor();
    const file = join(dataDir, "human-labels", "smoke", "tasks", "audit", "export", "labels", `${auditHex.slice(0, 12)}.json`);
    const doc = JSON.parse(readFileSync(file, "utf8")) as NodeLabels & Record<string, any>;
    expect(validate("node-labels", doc).issues).toEqual([]);
    expect(doc["studio"]).toMatchObject({ task: "audit", plan_sha256: PLAN_A, mode: "blind", draft: null });
    expect(doc.items).toHaveLength(total);

    await page.waitForTimeout(1200);
    await page.click("[data-testid=back]");
    await page.locator("[data-testid=task-view]").waitFor();
    await page.waitForFunction(() => document.querySelector("[data-testid=task-view] [data-testid=task-progress]")?.textContent?.startsWith("1/2"));
    expect(await page.locator(`[data-testid=page-row][data-hex="${auditHex}"]`).textContent()).toContain("exportada");
    await page.click("[data-testid=back-home]");
    await rows.first().waitFor();
    expect(await audit.locator("[data-testid=task-progress]").textContent()).toBe("1/2");
    const log = readFileSync(join(dataDir, "human-labels", "smoke", "tasks", "audit", "timelog.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log[0]).toMatchObject({ page: `sha256:${auditHex}`, mode: "blind" });
    expect(errors).toEqual([]);
    await context.close();
  });

  it("does the calibration: labels a group in the labeler, finishes it, sees the expected only afterwards", async () => {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${studio.url}#/t/calibration`);
    await page.locator("[data-testid=calibration-view]").waitFor();
    expect(await page.locator("[data-testid=cal-group]").count()).toBe(12);
    expect(await page.locator("[data-testid=cal-result]").count()).toBe(0);
    expect((await page.locator("[data-testid=cal-group]").allTextContents()).join(" ")).not.toMatch(/esperado/); // nothing of the expected before a group is finished

    await page.locator("[data-testid=cal-group][data-n='1'] [data-testid=open-article-1]").click();
    await page.locator("[data-testid=page-frame]").waitFor();
    expect(await page.textContent("[data-testid=mode-fixed]")).toContain("cego");
    expect(await page.locator("[data-testid=export]").count()).toBe(0); // calibration labels are not exported
    const g1 = page.locator("[data-testid=cal-side-group][data-n='1']");
    await g1.waitFor();
    await page.waitForFunction(() => /0\/2 unidades/.test(document.querySelector("[data-testid=cal-side-group][data-n='1']")?.textContent ?? ""));
    expect(await g1.locator("[data-testid=finish-group]").isDisabled()).toBe(true);

    const fl = page.frameLocator("[data-testid=page-frame]");
    await fl.locator("h1").click();
    await page.keyboard.press("1"); // h1: main (right)
    await fl.locator(".dek").click();
    await page.keyboard.press("3"); // dek: noise (wrong: it is main)
    await page.waitForFunction(() => /2\/2 unidades/.test(document.querySelector("[data-testid=cal-side-group][data-n='1']")?.textContent ?? ""));
    await page.waitForFunction(() => document.querySelector("[data-testid=save-status]")?.textContent === "saved");
    await g1.locator("[data-testid=finish-group]").click();
    const result = g1.locator("[data-testid=cal-result]");
    await result.waitFor();
    expect(await result.getAttribute("data-binary")).toBe("false");
    expect(await result.getAttribute("data-three")).toBe("false");
    const text = (await result.textContent()) ?? "";
    expect(text).toContain("1 erro(s)");
    expect(text).toContain("principal"); // expected, shown only now
    expect(text).toContain("ruído"); // what the owner gave
    await page.click("[data-testid=back]");
    await page.locator("[data-testid=calibration-view]").waitFor();
    await page.waitForFunction(() => /1\/12 grupos terminados/.test(document.querySelector("[data-testid=cal-score]")?.textContent ?? ""));
    expect(await page.locator("[data-testid=cal-group][data-n='1'][data-finished=true] [data-testid=cal-result]").count()).toBe(1);
    expect(errors).toEqual([]);
    await context.close();
  });
});
