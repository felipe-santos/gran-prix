// Shared by the browser tests: capture the 12 synthetic fixture pages once per test file.
import { sha256Of, type FileRef } from "@gran-prix/contracts";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserContext, Page } from "playwright-core";
import { buildPageSnapshot, launch, probeLoadedPage, type Launched, type PageSnapshotDoc, type ProbedPage } from "../../src/index.js";

export const FIXTURE_DIR = fileURLToPath(new URL("../../../../fixtures/pages/", import.meta.url));

export type Label = "main" | "support" | "noise" | null;

export interface TruthRule {
  selector: string;
  label: "main" | "support" | "noise";
}

export interface Captured {
  name: string;
  category: string;
  snapshot: PageSnapshotDoc;
  probed: ProbedPage;
  /** Truth label per node idx (null = no rule matched). */
  truth: Label[];
}

export function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.replace(/\.html$/, ""))
    .sort();
}

/** Nearest ancestor-or-self matched by a rule (later rule wins on the same element), over the composed tree. */
async function labelTruth(page: Page, rules: TruthRule[], n: number): Promise<Label[]> {
  return page.evaluate(
    ({ rules, n }) => {
      const out: (string | null)[] = new Array(n).fill(null);
      const composedParent = (el: Element): Element | null => {
        const p = el.parentNode;
        if (!p) return null;
        if (p.nodeType === 1) return p as Element;
        return (p as ShadowRoot).host ?? null;
      };
      const all: Element[] = [];
      const collect = (root: ParentNode): void => {
        for (const el of Array.from(root.querySelectorAll("*"))) {
          all.push(el);
          if (el.shadowRoot) collect(el.shadowRoot);
        }
      };
      collect(document);
      for (const el of all) {
        const id = el.getAttribute("data-gp-id");
        if (!id) continue;
        let cur: Element | null = el;
        let label: string | null = null;
        while (cur && label === null) {
          for (let r = rules.length - 1; r >= 0; r--) {
            let m = false;
            try { m = cur.matches((rules[r] as TruthRule).selector); } catch { /* bad selector */ }
            if (m) { label = (rules[r] as TruthRule).label; break; }
          }
          cur = composedParent(cur);
        }
        out[Number(id.slice(1))] = label;
      }
      return out;
    },
    { rules, n },
  ) as Promise<Label[]>;
}

export async function captureFixture(launched: Launched, name: string): Promise<Captured> {
  const { browser, context } = launched;
  const truthFile = JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.truth.json`, "utf8")) as { category: string; rules: TruthRule[] };
  const page = await (context as BrowserContext).newPage();
  try {
    const response = await page.goto(pathToFileURL(`${FIXTURE_DIR}${name}.html`).href, { waitUntil: "load" });
    const probed = await probeLoadedPage(page);
    const html: FileRef = {
      path: "rendered.html",
      sha256: sha256Of(probed.html),
      bytes: Buffer.byteLength(probed.html),
      media_type: "text/html",
    };
    const snapshot = buildPageSnapshot(probed.raw, {
      category: truthFile.category,
      html,
      capture: {
        collector_version: "features-test/0.1.0",
        browser: { name: "chromium", version: browser.version() },
        user_agent: await page.evaluate(() => navigator.userAgent),
        http_status: response?.status() || 200,
        captured_at: "2026-01-01T00:00:00Z",
        extra: { network: probed.network },
      },
    });
    const truth = await labelTruth(page, truthFile.rules, snapshot.nodes.length);
    return { name, category: truthFile.category, snapshot, probed, truth };
  } finally {
    await page.close();
  }
}

export async function captureAll(launched: Launched): Promise<Captured[]> {
  // Sequential on purpose: background tabs get throttled timers, which would distort the settle windows.
  const out: Captured[] = [];
  for (const n of fixtureNames()) out.push(await captureFixture(launched, n));
  return out;
}

export { launch };
