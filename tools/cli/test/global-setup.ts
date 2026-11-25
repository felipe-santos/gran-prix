// Builds the features bundle and a small corpus from the synthetic fixture pages once per run, for the
// label/dataset stage tests (they need real snapshots, features and flattened HTML). Needs Chromium.
// Excluded from `tsc` (tsconfig.json): it reaches into sibling packages by path.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
// @ts-expect-error plain .mjs without declarations
import { writeBundle } from "../../../packages/features/scripts/bundle.mjs";
import { buildCorpus } from "../../../packages/labels/src/testing/index.js";

export const CORPUS_PAGES = ["article-1", "article-2", "docs-1", "forum-1", "landing-1", "product-1"];

export default async function setup(project: TestProject): Promise<() => void> {
  await writeBundle();
  const dir = mkdtempSync(join(tmpdir(), "gp-cli-corpus-"));
  await buildCorpus({ outDir: dir, names: CORPUS_PAGES });
  project.provide("corpusDir", dir);
  return () => rmSync(dir, { recursive: true, force: true });
}
