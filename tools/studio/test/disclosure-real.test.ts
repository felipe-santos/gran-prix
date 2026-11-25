// The real collector now sets flags.disclosure: collect fixtures/pages/docs-3.html (all four collapsed patterns plus a
// hidden modal and an off-screen ad) with the gp `collect` stage and check which of its text units are in U.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PipelineSpec } from "@gran-prix/contracts";
import { runPipeline } from "@gran-prix/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PageCache } from "../src/server/pages.js";
import { listPages } from "../src/server/snapshot-set.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
let page: ReturnType<PageCache["load"]>;

beforeAll(async () => {
  const work = tmpDir();
  const dataDir = join(work, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(work, "urls.json"), JSON.stringify([{ url: "fixtures/pages/docs-3.html", stratum: "docs" }]));
  const spec: PipelineSpec = {
    format: "gran-prix.pipeline-spec",
    format_version: "1.0.0",
    name: "studio-test-disclosure",
    externals: { urls: { type: "UrlList", path: join(work, "urls.json") } },
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
  page = new PageCache().load(listPages(dataDir)[0]!);
}, 120_000);
afterAll(cleanupTmp);

/** u of the first text unit whose text starts with `frag`: 0 not in U, 1 rendered, 2 disclosure. */
const u = (frag: string): number => {
  const n = page.nodes.find((x) => x.x.startsWith(frag));
  if (!n) throw new Error(`no node starting with ${frag}`);
  return n.u;
};

describe("collapsed content of the real collector in U", () => {
  it("(a) closed details, (b) accordion, (c) inactive tabpanel and (d) until-found are disclosure units (u = 2)", () => {
    for (const frag of [
      "Check that the proxy allows", "Raise the idle timeout", "How do I see the open stream?", "A proxy that inspects traffic", // (a)
      "A single reading may carry", "Failed sends are retried", // (b)
      "Variables are read once", "The file is searched in", // (c)
      "Versions before 2.4", "Versions before 2.1", // (d)
    ]) expect(u(frag), frag).toBe(2);
  });

  it("visible content, summaries and controls stay ordinary rendered units (u = 1)", () => {
    for (const frag of ["The relay forwards sensor readings", "The relay starts but no readings arrive", "On Linux the relay logs", "Payload size", "The local queue holds", "Command line"]) {
      expect(u(frag), frag).toBe(1);
    }
  });

  it("a hidden modal, a hidden drawer menu, an off-screen ad and their <details> are NOT in U", () => {
    for (const frag of ["Tell us what was missing", "What do we do with it?", "Feedback is read by", "Overview", "Sponsored: Lantern Cloud", "Why this ad?", "Shown because the page", "You are reading an older copy", "Draft note"]) {
      expect(u(frag), frag).toBe(0);
    }
  });
});
