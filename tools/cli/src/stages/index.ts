/**
 * Single registration point for every stage plugin the `gp` CLI knows.
 *
 * Each lane adds its stages here: one import line and one spread entry.
 * Keep the list ordered by lane so parallel merges stay trivial.
 */
import type { StagePlugin } from "../stage.js";
import { BASELINE_LABEL_STAGES } from "./baselines/label-baselines.js";
import { COLLECT_STAGES } from "./collect-stages.js";
import { DEMO_STAGES } from "./demo.js";
import { EVALUATE_STAGES } from "./evaluate/index.js";
import { LABELING_STAGES } from "./labeling.js";
import { LLM_LABEL_STAGES } from "./label-llm.js";
import { packageStage } from "./package.js";
import { trainStage } from "./train.js";
import { TRAIN_CV_STAGES } from "./train-cv/index.js";

export const ALL_STAGES: StagePlugin[] = [
  ...DEMO_STAGES,
  // L4 (data): collect + extract
  ...COLLECT_STAGES,
  // L4b (labels): label.heuristic, label.truth, label.merge + dataset.jsonl
  ...LABELING_STAGES,
  // L4b (labels): label.llm (E2.6; paid calls only through the ledger, content-hash cache, dry_run)
  ...LLM_LABEL_STAGES,
  // L1 (engine): train (gp-train, rust) and package (deployable bundle)
  trainStage,
  packageStage,
  // L5 (science): evaluate.intrinsic + baseline labelers (label.trafilatura, label.defuddle, label.router)
  ...BASELINE_LABEL_STAGES,
  ...EVALUATE_STAGES,
  // L5e (decision chain): train.cv (nested grouped CV of the MLP: OOF bundle, tau*, final model)
  ...TRAIN_CV_STAGES,
];
