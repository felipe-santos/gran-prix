// Runs the Python unit tests of tools/baselines (GBDT, U2 metric/sampling, Trafilatura sidecar) from the JS suite, so
// `pnpm test:js` covers them. Skipped, loudly, when numpy/scikit-learn are not installed in tools/baselines/.pylibs.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BASELINES = fileURLToPath(new URL("../../baselines/", import.meta.url));
const PYLIBS = join(BASELINES, ".pylibs");
const ready = existsSync(join(PYLIBS, "sklearn")) && existsSync(join(PYLIBS, "numpy"));
if (!ready) console.warn("[baselines] Python unit tests SKIPPED: install tools/baselines/requirements.txt into tools/baselines/.pylibs");

(ready ? describe : describe.skip)("tools/baselines Python unit tests", () => {
  it("pass (unittest discover)", () => {
    const r = spawnSync("python3", ["-m", "unittest", "discover", "-s", "test", "-p", "test_*.py"], {
      cwd: BASELINES,
      env: { ...process.env, PYTHONPATH: PYLIBS, PYTHONDONTWRITEBYTECODE: "1", OMP_NUM_THREADS: "2" },
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/Ran \d+ tests?/);
    expect(r.stderr).not.toMatch(/skipped/);
  }, 180_000);
});
