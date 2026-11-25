/**
 * TEST SUPPORT (not part of the labeling API): builds a small corpus from the synthetic pages in
 * `fixtures/pages/` the way the collect and extract stages do, so labelers and stages can be tested
 * without a network. Needs the `@gran-prix/features` bundle (`gp-features.iife.js`) and Chromium.
 *
 * Layout written under `outDir` (the real collect/extract layout, plus oracle files for the tests):
 *   snapshot-set/manifest.json            SnapshotSetManifest (format gran-prix.snapshot-set), entries in order
 *   snapshot-set/snapshots/<hex>.json     PageSnapshot (<hex> = snapshot_id without "sha256:")
 *   snapshot-set/html/<hex>.html.gz       gzip of the FLATTENED HTML (open shadow roots inlined, scripts emptied);
 *                                         <hex> = sha256 of the DECODED html, which is what the FileRef hashes
 *   features-set/manifest.json            NodeFeaturesSetManifest (format gran-prix.node-features-set)
 *   features-set/features/<hex>.json      NodeFeatures under FeatureSchema v0 (<hex> = snapshot id)
 *   schema.json                           FeatureSchema v0
 *   truth/<name>.json                     the fixture's truth rules ({ category, rules })
 *   browser-truth/<name>.json             truth label per node idx evaluated in the LIVE page (oracle)
 *   index.json                            [{ name, snapshot_id, hex }]
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { sha256Hex, sha256Of, type FileRef } from "@gran-prix/contracts";
import { buildPageSnapshot, featureSchemaV0, launch, probeLoadedPage, vectorize } from "@gran-prix/features";
import {
  FEATURES_SET_FORMAT,
  SNAPSHOT_SET_FORMAT,
  type NodeFeaturesSetEntry,
  type NodeFeaturesSetManifest,
  type SnapshotSetEntry,
  type SnapshotSetManifest,
} from "../set-readers.js";

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
    // scripts stay, emptied: removing them would shift the ids
    for (const s of Array.from(clone.querySelectorAll("script"))) {
      for (const a of Array.from(s.attributes)) if (a.name !== "data-gp-id") s.removeAttribute(a.name);
      s.textContent = "";
    }
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
  const dirs = ["snapshot-set/snapshots", "snapshot-set/html", "features-set/features", "truth", "browser-truth"].map((d) => join(opts.outDir, d));
  for (const d of dirs) mkdirSync(d, { recursive: true });
  writeFileSync(join(opts.outDir, "schema.json"), JSON.stringify(featureSchemaV0));
  const index: Array<{ name: string; snapshot_id: string; hex: string }> = [];
  const snapshotEntries: SnapshotSetEntry[] = [];
  const featureEntries: NodeFeaturesSetEntry[] = [];
  const { browser, context } = await launch();
  try {
    // Sequential on purpose: background tabs get throttled timers, which would distort the settle windows.
    for (const name of names) {
      const truth = JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.truth.json`), "utf8")) as FixtureTruth;
      const page = await context.newPage();
      try {
        const response = await page.goto(pathToFileURL(join(FIXTURE_DIR, `${name}.html`)).href, { waitUntil: "load" });
        const probed = await probeLoadedPage(page);
        const decoded = Buffer.from(await flattenedHtml(page), "utf8");
        const htmlHex = sha256Hex(decoded);
        const gz = new Uint8Array(gzipSync(decoded));
        const html = {
          path: `html/${htmlHex}.html.gz`,
          sha256: sha256Of(decoded),
          bytes: decoded.length,
          media_type: "text/html",
          content_encoding: "gzip",
        } as FileRef;
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
        const hex = snapshot.snapshot_id.slice("sha256:".length);
        writeFileSync(join(opts.outDir, "snapshot-set", "snapshots", `${hex}.json`), JSON.stringify(snapshot));
        writeFileSync(join(opts.outDir, "snapshot-set", "html", `${htmlHex}.html.gz`), gz);
        const features = vectorize(snapshot, featureSchemaV0);
        writeFileSync(join(opts.outDir, "features-set", "features", `${hex}.json`), JSON.stringify(features));
        index.push({ name, snapshot_id: snapshot.snapshot_id, hex });
        snapshotEntries.push({
          snapshot_id: snapshot.snapshot_id,
          url: snapshot.page.url,
          final_url: snapshot.page.final_url,
          stratum: truth.category,
          group_key: snapshot.page.group_key,
          http_status: snapshot.capture.http_status,
          flags: [],
          node_count: snapshot.nodes.length,
          snapshot: `snapshots/${hex}.json`,
          html: html.path,
        });
        featureEntries.push({
          snapshot_id: snapshot.snapshot_id,
          features_id: features.features_id,
          group_key: snapshot.page.group_key,
          stratum: truth.category,
          flags: [],
          n_rows: features.unit_ids.length,
          features: `features/${hex}.json`,
        });
        writeFileSync(join(opts.outDir, "truth", `${name}.json`), JSON.stringify(truth));
        writeFileSync(join(opts.outDir, "browser-truth", `${name}.json`), JSON.stringify(await browserTruth(page, truth.rules, snapshot.nodes.length)));
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  const snapshotManifest: SnapshotSetManifest = { format: SNAPSHOT_SET_FORMAT, format_version: "1.0.0", entries: snapshotEntries, failures: [] };
  const featuresManifest: NodeFeaturesSetManifest = {
    format: FEATURES_SET_FORMAT,
    format_version: "1.0.0",
    feature_schema_id: featureSchemaV0.schema_id,
    entries: featureEntries,
  };
  writeFileSync(join(opts.outDir, "snapshot-set", "manifest.json"), JSON.stringify(snapshotManifest));
  writeFileSync(join(opts.outDir, "features-set", "manifest.json"), JSON.stringify(featuresManifest));
  writeFileSync(join(opts.outDir, "index.json"), JSON.stringify(index));
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
