// Shared by the train.cv stage test and the experiment-variant test: a small synthetic Dataset (14 dev pages on 14 domains,
// 4 test pages) and a private copy of the gp-train binary. A pipeline test, not a quality claim.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultGpTrainPath } from "../src/stages/train.js";
import { buildDataset, snapshotOf, synthRows, type SynthGroup } from "./evaluate-fixtures.js";
import { tmpDir } from "./helpers.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export const CV_GROUPS: SynthGroup[] = [
  ...Array.from({ length: 14 }, (_, i): SynthGroup => ({
    id: `d${String(i).padStart(2, "0")}`,
    key: `dev${i}.example`,
    stratum: ["docs", "shop", "forum"][i % 3] as string,
    split: i < 10 ? "train" : "val",
    snapshot: snapshotOf(i + 1),
  })),
  ...Array.from({ length: 4 }, (_, i): SynthGroup => ({ id: `t${i}`, key: `test${i}.example`, stratum: ["docs", "shop"][i % 2] as string, split: "test", snapshot: snapshotOf(i + 20) })),
];
export const CV_ROWS = synthRows(CV_GROUPS, 50, 11);

/** The Dataset files; with `corruptTest`, test.jsonl is garbage while the manifest still pins the real hash. */
export function datasetFiles(corruptTest: boolean): Record<string, string> {
  const f = buildDataset(CV_GROUPS, CV_ROWS, { rowWeight: true });
  if (corruptTest) f["test.jsonl"] = "this is not json\n";
  return f;
}

/** A private copy of gp-train (the shared target may be rebuilt by someone else while tests run). Builds it when missing. */
export function gpTrainCopy(): string {
  const real = process.env["GP_TRAIN_BIN"] ?? defaultGpTrainPath();
  if (!existsSync(real)) {
    const r = spawnSync("cargo", ["build", "--release", "-p", "gp-train"], { cwd: ROOT, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`cannot build gp-train: ${r.stderr.slice(-1500)}`);
  }
  const binary = join(tmpDir("gp-bin-"), "gp-train");
  copyFileSync(existsSync(real) ? real : defaultGpTrainPath(), binary);
  return binary;
}
