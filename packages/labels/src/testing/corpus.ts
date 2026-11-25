/**
 * TEST SUPPORT (not part of the labeling API): builds a small corpus from the synthetic pages in
 * `fixtures/pages/` the way the collect and extract stages do, so labelers and stages can be tested
 * without a network. Needs the `@gran-prix/features` bundle (`gp-features.iife.js`) and Chromium.
 *
 * Layout written under `outDir`:
 *   snapshots/<name>/snapshot.json   PageSnapshot (html FileRef -> page.html.gz, relative to this folder)
 *   snapshots/<name>/page.html.gz    gzip of the FLATTENED HTML: open shadow roots inlined, scripts removed
 *   features/<name>.json             NodeFeatures under FeatureSchema v0
 *   schema.json                      FeatureSchema v0
 *   truth/<name>.json                the fixture's truth rules ({ category, rules })
 *   browser-truth/<name>.json        truth label per node idx evaluated in the LIVE page (oracle)
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { sha256Of, type FileRef } from "@gran-prix/contracts";
import { buildPageSnapshot, featureSchemaV0, launch, probeLoadedPage, vectorize } from "@gran-prix/features";

type Page = Parameters<typeof probeLoadedPage>[0];

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "fixtures", "pages");

export interface FixtureTruth {
  category: string;
  rules: Array<{ selector: string; label: "main" | "support" | "noise" }>;
}

export function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.replace(/\.html$/, ""))
    .sort();
}

/** The two article pages share a domain (to exercise grouping); every other page has its own. */
export function groupKeyOf(name: string): string {
  return name.startsWith("article-") ? "news.example" : `${name}.example`;
}

/** Mirrors the spike's `flattenedHtml`: clone, inline open shadow roots, drop scripts. Runs in the page. */
async function flattenedHtml(page: Page): Promise<string> {
  return page.evaluate(() => {
    const clone = document.cloneNode(true) as Document;
    const hosts: Element[] = [];
    const collect = (root: ParentNode): void => {
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if (el.shadowRoot) {
          hosts.push(el);
          collect(el.shadowRoot);
        }
      }
    };
    collect(document);
    for (const host of hosts) {
      const target = clone.querySelector(`[data-gp-id="${host.getAttribute("data-gp-id")}"]`);
      if (!target) continue;
      const frag = clone.createDocumentFragment();
      for (const child of Array.from((host.shadowRoot as ShadowRoot).childNodes)) frag.append(clone.importNode(child, true));
      target.prepend(frag);
    }
    for (const s of Array.from(clone.querySelectorAll("script"))) s.remove();
    return clone.documentElement.outerHTML;
  });
}

/** Truth label per node idx in the live (composed) tree, the way the spike computes it. */
async function browserTruth(page: Page, rules: FixtureTruth["rules"], n: number): Promise<Array<string | null>> {
  return page.evaluate(
    ({ rules, n }) => {
      const out: Array<string | null> = new Array(n).fill(null);
      const parentOf = (el: Element): Element | null => {
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
            try {
              m = cur.matches((rules[r] as { selector: string }).selector);
            } catch {
              /* invalid selector */
            }
            if (m) {
              label = (rules[r] as { label: string }).label;
              break;
            }
          }
          cur = parentOf(cur);
        }
        out[Number(id.slice(1))] = label;
      }
      return out;
    },
    { rules, n },
  );
}

export interface BuildCorpusOptions {
  outDir: string;
  /** Fixture names (default: all 12). */
  names?: readonly string[];
}

export async function buildCorpus(opts: BuildCorpusOptions): Promise<string[]> {
  const names = opts.names ?? fixtureNames();
  const dirs = ["snapshots", "features", "truth", "browser-truth"].map((d) => join(opts.outDir, d));
  for (const d of dirs) mkdirSync(d, { recursive: true });
  writeFileSync(join(opts.outDir, "schema.json"), JSON.stringify(featureSchemaV0));
  const { browser, context } = await launch();
  try {
    // Sequential on purpose: background tabs get throttled timers, which would distort the settle windows.
    for (const name of names) {
      const truth = JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.truth.json`), "utf8")) as FixtureTruth;
      const page = await context.newPage();
      try {
        const response = await page.goto(pathToFileURL(join(FIXTURE_DIR, `${name}.html`)).href, { waitUntil: "load" });
        const probed = await probeLoadedPage(page);
        const gz = new Uint8Array(gzipSync(Buffer.from(await flattenedHtml(page), "utf8")));
        const html: FileRef = { path: "page.html.gz", sha256: sha256Of(gz), bytes: gz.length, media_type: "application/gzip" };
        const snapshot = buildPageSnapshot(probed.raw, {
          category: truth.category,
          group_key: groupKeyOf(name),
          html,
          capture: {
            collector_version: "labels-test/0.1.0",
            browser: { name: "chromium", version: browser.version() },
            user_agent: await page.evaluate(() => navigator.userAgent),
            http_status: response?.status() || 200,
            captured_at: "2026-01-01T00:00:00Z",
          },
        });
        const sdir = join(opts.outDir, "snapshots", name);
        mkdirSync(sdir, { recursive: true });
        writeFileSync(join(sdir, "snapshot.json"), JSON.stringify(snapshot));
        writeFileSync(join(sdir, "page.html.gz"), gz);
        writeFileSync(join(opts.outDir, "features", `${name}.json`), JSON.stringify(vectorize(snapshot, featureSchemaV0)));
        writeFileSync(join(opts.outDir, "truth", `${name}.json`), JSON.stringify(truth));
        writeFileSync(join(opts.outDir, "browser-truth", `${name}.json`), JSON.stringify(await browserTruth(page, truth.rules, snapshot.nodes.length)));
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return [...names];
}

/** Reads a directory of a corpus into the `{ path: bytes }` shape of a file-set artifact. */
export function readTree(root: string, sub: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(root, sub, rel), { withFileTypes: true })) {
      const p = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else out[p] = new Uint8Array(readFileSync(join(root, sub, p)));
    }
  };
  walk("");
  return out;
}
