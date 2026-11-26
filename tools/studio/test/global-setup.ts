// Builds, once per run, the SnapshotSet the Studio tests label: the real `collect` stage of the gp runner over two
// synthetic fixture pages (article-1: hidden/sr-only/modal elements; product-2: open Shadow DOM), stored in a data
// dir's artifact store, and a second one over the 10 fixture pages of the calibration exercise (guide section 7). Needs Chromium. Also builds the UI bundle the smoke test serves. Excluded from `tsc`
// (it reaches into sibling packages by path).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PipelineSpec } from "@gran-prix/contracts";
import { runPipeline } from "@gran-prix/cli";
import type { TestProject } from "vitest/node";
import { build } from "vite";
// @ts-expect-error plain .mjs without declarations
import { writeBundle } from "../../../packages/features/scripts/bundle.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const FIXTURE_PAGES = [
  { url: "fixtures/pages/article-1.html", stratum: "article" },
  { url: "fixtures/pages/product-2.html", stratum: "product" },
];

/** The 10 fixture pages the 12 groups of the calibration exercise use. */
export const CALIBRATION_PAGES = ["article-1", "article-2", "product-1", "product-2", "docs-1", "docs-2", "forum-1", "forum-2", "landing-1", "landing-2"].map((n) => ({
  url: `fixtures/pages/${n}.html`,
  stratum: n.split("-")[0] as string,
}));

async function collectInto(dataDir: string, work: string, name: string, pages: Array<{ url: string; stratum: string }>): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const urls = join(work, `${name}-urls.json`);
  writeFileSync(urls, JSON.stringify(pages));
  const spec: PipelineSpec = {
    format: "gran-prix.pipeline-spec",
    format_version: "1.0.0",
    name: `studio-test-${name}`,
    externals: { urls: { type: "UrlList", path: urls } },
    stages: [
      {
        id: "collect",
        kind: "collect",
        impl: "ts:collect.playwright@1.0.0",
        params: { viewport: [1280, 900], captured_at: "2026-01-01T00:00:00Z", base_dir: ROOT },
        inputs: { urls: { external: "urls" } },
      },
    ],
  };
  const run = await runPipeline(spec, { dataDir, root: ROOT, log: () => undefined });
  if (!run.ok) throw new Error(`collect failed: ${JSON.stringify(run.stages.map((s) => [s.stageId, s.status, s.error]))}`);
}

export default async function setup(project: TestProject): Promise<() => void> {
  await writeBundle();
  const work = mkdtempSync(join(tmpdir(), "gp-studio-corpus-"));
  const dataDir = join(work, "data");
  await collectInto(dataDir, work, "collect", FIXTURE_PAGES);
  project.provide("corpusDataDir", dataDir);
  const calDir = join(work, "data-calibration");
  await collectInto(calDir, work, "calibration", CALIBRATION_PAGES);
  project.provide("calibrationDataDir", calDir);

  if (existsSync(fileURLToPath(new URL("../src/ui/index.html", import.meta.url)))) await build({ configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)), logLevel: "warn", mode: "production" });
  return () => rmSync(work, { recursive: true, force: true });
}
