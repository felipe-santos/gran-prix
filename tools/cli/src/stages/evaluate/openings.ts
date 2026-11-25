import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sha256 } from "@gran-prix/contracts";

/**
 * The blindness register of the protocol (section 13: "the test is opened ONCE per frozen model"). Every evaluate that
 * reads the test split (`split: "test"` or `"all"`) appends one line to `<data dir>/test-openings.jsonl` BEFORE it
 * scores a single row. A second opening of the same `(model_id, dataset_id)` is refused unless `params.reopen_reason`
 * says why; the reopening is registered too, with its reason, so the file is the audit trail of every look at the test.
 *
 * Append-only and next to the spend ledger (`ledger.jsonl`), per data dir. A cache hit does not run the stage, so it
 * does not count: nothing was scored. Not a lock: two evaluates racing on the same pair could both pass the check
 * (the runner executes a pipeline's stages one at a time, so inside one run this cannot happen).
 */

export const OPENINGS_FILE = "test-openings.jsonl";

export interface TestOpening {
  event: "open";
  ts: string;
  run_id: string;
  stage_id: string;
  model_id: Sha256;
  dataset_id: Sha256;
  split: "test" | "all";
  /** Present on a reopening (a second look at the same pair): the reason the run was given. */
  reopen_reason?: string;
  reopened?: true;
}

export const openingsPath = (dataDir: string): string => join(dataDir, OPENINGS_FILE);

export function readOpenings(dataDir: string): TestOpening[] {
  const file = openingsPath(dataDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as TestOpening);
}

export class TestReopenedError extends Error {
  constructor(
    readonly modelId: Sha256,
    readonly datasetId: Sha256,
    readonly previous: TestOpening,
  ) {
    super(
      `the test split was already opened for model ${modelId.slice(0, 19)} on dataset ${datasetId.slice(0, 19)} (run ${previous.run_id}, stage ${previous.stage_id}, ${previous.ts}): ` +
        "the protocol opens the test ONCE per frozen model (section 13). If a second look is a declared deviation, give params.reopen_reason; it is registered in test-openings.jsonl.",
    );
    this.name = "TestReopenedError";
  }
}

export interface OpeningRequest {
  dataDir: string;
  runId: string;
  stageId: string;
  modelId: Sha256;
  datasetId: Sha256;
  split: "test" | "all";
  reopenReason?: string;
  now?: () => Date;
}

/** Registers an opening, or throws `TestReopenedError` when the pair was opened before and no reason was given. Returns whether it is a reopening. */
export function registerOpening(req: OpeningRequest): { reopened: boolean } {
  const previous = readOpenings(req.dataDir).find((o) => o.model_id === req.modelId && o.dataset_id === req.datasetId);
  if (previous && !req.reopenReason) throw new TestReopenedError(req.modelId, req.datasetId, previous);
  const entry: TestOpening = {
    event: "open",
    ts: (req.now ?? (() => new Date()))().toISOString(),
    run_id: req.runId,
    stage_id: req.stageId,
    model_id: req.modelId,
    dataset_id: req.datasetId,
    split: req.split,
    ...(req.reopenReason ? { reopen_reason: req.reopenReason } : {}),
    ...(previous ? { reopened: true as const } : {}),
  };
  const file = openingsPath(req.dataDir);
  mkdirSync(req.dataDir, { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return { reopened: previous !== undefined };
}
