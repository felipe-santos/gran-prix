import { cpSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, inject, it } from "vitest";
import { main, parseCli } from "../src/server/cli.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

describe("gp-studio command line", () => {
  it("parses the options and defaults to the safe blind mode and a free port", () => {
    const a = parseCli(["--data-dir", "d", "--annotator", "ana.silva"], "/work");
    expect(a).toMatchObject({ dataDir: resolve("/work", "d"), annotator: "ana.silva", port: 0, defaultMode: "blind", help: false });
    const b = parseCli(["--port", "4817", "--default-mode", "review", "--guide", "g.md"], "/work");
    expect(b).toMatchObject({ port: 4817, defaultMode: "review", guidePath: resolve("/work", "g.md"), dataDir: resolve("/work", "data") });
  });

  it("rejects bad input as usage errors", () => {
    for (const argv of [["--annotator", "../x"], ["--annotator", "a b"], ["--port", "99999"], ["--port", "x"], ["--default-mode", "both"], ["--nope"], ["stray"]]) {
      expect(() => parseCli(argv, "/work"), argv.join(" ")).toThrow();
    }
  });

  it("main returns 2 for a usage error or a missing data dir, and a running server (127.0.0.1) otherwise", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd: tmpDir() };
    expect(await main(["--annotator", "../x"], io)).toBe(2);
    expect(await main(["--data-dir", "does-not-exist"], io)).toBe(2);
    expect(err.join("\n")).toContain("does not exist");
    expect(await main(["--help"], io)).toBe(0);
    const data = join(io.cwd, "data");
    cpSync(inject("corpusDataDir"), data, { recursive: true });
    const run = await main(["--data-dir", data, "--annotator", "cli-test"], io);
    expect(typeof run).not.toBe("number");
    if (typeof run === "number") return;
    try {
      expect(out.join("\n")).toContain("2 page(s)");
      expect(out.join("\n")).toContain("127.0.0.1 only");
      expect(out.join("\n")).toContain(run.url);
      expect(existsSync(join(data, "human-labels"))).toBe(false); // nothing is written until you label
    } finally {
      await run.close();
    }
  });
});
