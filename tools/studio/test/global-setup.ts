// Builds, once per run, the SnapshotSet the Studio tests label: the real `collect` stage of the gp runner over two
// synthetic fixture pages (article-1: hidden/sr-only/modal elements; product-2: open Shadow DOM), stored in a data
// dir's artifact store. Needs Chromium. Also builds the UI bundle the smoke test serves. Excluded from `tsc`
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

export default async function setup(project: TestProject): Promise<() => void> {
  await writeBundle();
  const work = mkdtempSync(join(tmpdir(), "gp-studio-corpus-"));
  const dataDir = join(work, "data");
  mkdirSync(dataDir, { recursive: true });
  const urls = join(work, "urls.json");
  writeFileSync(urls, JSON.stringify(FIXTURE_PAGES));
  const spec: PipelineSpec = {
    format: "gran-prix.pipeline-spec",
    format_version: "1.0.0",
    name: "studio-test-collect",
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
  project.provide("corpusDataDir", dataDir);

  if (existsSync(fileURLToPath(new URL("../src/ui/index.html", import.meta.url)))) await build({ configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)), logLevel: "warn", mode: "production" });
  return () => rmSync(work, { recursive: true, force: true });
}
