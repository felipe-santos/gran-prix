// Headless-Chromium smoke test of the whole Studio: real collect output of two fixture pages, the real server and the
// built UI. A "human" labels every unit of U by keyboard events, exports, and the exported files are validated
// against @gran-prix/contracts.
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "@gran-prix/features";
import { validate, type NodeLabels } from "@gran-prix/contracts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { startStudio, type RunningStudio } from "../src/server/app.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

const uiDir = fileURLToPath(new URL("../dist/ui", import.meta.url));

let studio: RunningStudio;
let dataDir: string;
let browser: Awaited<ReturnType<typeof launch>>["browser"];
let context: Awaited<ReturnType<typeof launch>>["context"];

beforeAll(async () => {
  expect(existsSync(join(uiDir, "index.html")), "the UI must be built (vite build): the global setup does it").toBe(true);
  dataDir = tmpDir("gp-studio-smoke-");
  cpSync(inject("corpusDataDir"), dataDir, { recursive: true });
  studio = await startStudio({ dataDir, annotator: "smoke", uiDir });
  ({ browser, context } = await launch());
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  cleanupTmp();
});

const readLabels = (hex: string): NodeLabels & Record<string, any> =>
  JSON.parse(readFileSync(join(dataDir, "human-labels", "smoke", "export", "labels", `${hex.slice(0, 12)}.json`), "utf8"));

describe("headless smoke: label by keyboard, export, validate", () => {
  it("labels every unit of two pages (one blind, one review) and exports contract-valid NodeLabels", async () => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => void d.accept()); // the "accept every remaining draft" confirmation
    await page.goto(studio.url);
    const rows = page.locator("[data-testid=page-row]");
    await rows.first().waitFor();
    expect(await rows.count()).toBe(2);
    expect(await page.textContent("[data-testid=annotator]")).toBe("smoke");

    // ---------- page 1 (article), BLIND ----------
    const hexes = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-hex") as string));
    const [blindHex, reviewHex] = hexes as [string, string];
    await rows.nth(0).locator("a").click();
    const frame = page.locator("[data-testid=page-frame]");
    await frame.waitFor();
    expect(await frame.getAttribute("sandbox")).toBe("allow-same-origin"); // no allow-scripts
    const progress = async (): Promise<[number, number]> => {
      const m = /(\d+)\/(\d+) labeled/.exec((await page.textContent("[data-testid=progress-text]")) ?? "");
      return [Number(m?.[1]), Number(m?.[2])];
    };
    await page.waitForFunction(() => /\/\d+ labeled/.test(document.querySelector("[data-testid=progress-text]")?.textContent ?? ""));
    const [, total] = await progress();
    expect(total).toBeGreaterThan(20);
    // the page really is in the frame, with its outline overlay: every unit of U carries a data-gp-u attribute
    const fl = page.frameLocator("[data-testid=page-frame]");
    await fl.locator("h1").waitFor();
    expect(await fl.locator("[data-gp-u]").count()).toBe(total);
    // a hidden element (the subscribe modal) is not in U: no unit attribute on it
    expect(await fl.locator("#subscribe-modal[data-gp-u]").count()).toBe(0);

    // click inside the frame selects; keys typed with focus in the frame reach the labeler
    await fl.locator("h1").click();
    await page.waitForFunction(() => /h1/.test(document.querySelector("[data-testid=node-info]")?.textContent ?? ""));
    await page.keyboard.press("1"); // h1 -> main, then auto-advance
    expect(await progress()).toEqual([1, total]);

    // export is refused while U has unlabeled units, and lists them
    await page.keyboard.press("e");
    await page.locator("[data-testid=export-result][data-ok=false]").waitFor();
    expect(await page.textContent("[data-testid=export-result]")).toContain(`${total - 1} unit(s) of U have no label`);

    // label everything else through the keyboard only: 2 (support) / 3 (noise), a doubt flag and a mixed flag on the way
    await page.keyboard.press("j"); // next unlabeled
    await page.keyboard.press("3");
    await page.keyboard.press("d"); // flag applies to the node just labeled
    await page.keyboard.press("m");
    for (let guard = 0; guard < total + 5; guard++) {
      const [done] = await progress();
      if (done === total) break;
      await page.keyboard.press(guard % 3 === 0 ? "2" : "3");
    }
    expect(await progress()).toEqual([total, total]);
    await page.waitForFunction(() => document.querySelector("[data-testid=save-status]")?.textContent === "saved");
    await page.keyboard.press("e");
    await page.locator("[data-testid=export-result][data-ok=true]").waitFor();

    const doc = readLabels(blindHex);
    const v = validate("node-labels", doc);
    expect(v.issues).toEqual([]);
    expect(doc.labeler).toMatchObject({ id: "human@smoke", kind: "human" });
    expect(doc.items).toHaveLength(total);
    expect(doc.items.every((i) => i.source === "human" && i.confidence === 1)).toBe(true);
    expect(doc.items.filter((i) => i.y === 0)).toHaveLength(1); // only the h1 was labeled main
    expect(doc.items.filter((i) => i.reason === "doubt,mixed")).toHaveLength(1);
    expect(doc["studio"]).toMatchObject({ mode: "blind", n_doubt: 1, n_mixed: 1 });

    // active time is logged when leaving the page (wait for at least one full second of work first)
    await page.waitForTimeout(1500);
    await page.click("[data-testid=back]");
    await rows.first().waitFor();

    // ---------- page 2 (product), REVIEW ----------
    await rows.nth(1).getByRole("button", { name: "review" }).click();
    await rows.nth(1).locator("a").click();
    await page.locator("[data-testid=page-frame]").waitFor();
    await page.waitForFunction(() => /\/\d+ labeled/.test(document.querySelector("[data-testid=progress-text]")?.textContent ?? ""));
    const [, total2] = await progress();
    expect(total2).toBeGreaterThan(20);
    await page.locator("[data-testid=node-info]").waitFor();
    expect(await page.textContent("[data-testid=node-info]")).toContain("Draft (readability"); // the draft is shown in review mode
    await page.keyboard.press("Shift+C"); // accept every draft label (the dialog is auto-accepted)
    await page.waitForFunction((t) => document.querySelector("[data-testid=progress-text]")?.textContent?.startsWith(`${t}/`), total2);
    // the reviewer disagrees with the draft on one node
    await page.keyboard.press("ArrowDown");
    const before = await page.textContent("[data-testid=progress]");
    await page.keyboard.press("2");
    await page.waitForFunction((b) => document.querySelector("[data-testid=progress]")?.textContent !== b, before);
    await page.waitForFunction(() => document.querySelector("[data-testid=save-status]")?.textContent === "saved");
    await page.keyboard.press("e");
    await page.locator("[data-testid=export-result][data-ok=true]").waitFor();
    const doc2 = readLabels(reviewHex);
    expect(validate("node-labels", doc2).issues).toEqual([]);
    expect(doc2.items).toHaveLength(total2);
    expect(doc2["studio"]).toMatchObject({ mode: "review" });
    expect(doc2["studio"].draft.labeler_id).toMatch(/^readability/);
    expect(doc2.labels_id).not.toBe(doc.labels_id);

    // the time log has the blind session; nothing in the UI crashed
    const log = readFileSync(join(dataDir, "human-labels", "smoke", "timelog.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0]).toMatchObject({ page: `sha256:${blindHex}`, mode: "blind", annotator: "smoke" });
    expect(log[0].seconds).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
    await page.close();
  });
});
