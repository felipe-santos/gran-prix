// Builds the features in-page bundle, then the 12-fixture corpus once per run (Chromium: ~1 s per page).
// The corpus directory reaches the tests through `provide`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
// @ts-expect-error plain .mjs without declarations
import { writeBundle } from "../../features/scripts/bundle.mjs";
import { buildCorpus } from "../src/testing/index.js";

export default async function setup(project: TestProject): Promise<() => void> {
  await writeBundle();
  const dir = mkdtempSync(join(tmpdir(), "gp-labels-corpus-"));
  await buildCorpus({ outDir: dir });
  project.provide("corpusDir", dir);
  return () => rmSync(dir, { recursive: true, force: true });
}

declare module "vitest" {
  export interface ProvidedContext {
    corpusDir: string;
  }
}
