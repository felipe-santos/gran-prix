/**
 * Single registration point for every stage plugin the `gp` CLI knows.
 *
 * Each lane adds its stages here: one import line and one spread entry.
 * Keep the list ordered by lane so parallel merges stay trivial.
 */
import type { StagePlugin } from "../stage.js";
import { DEMO_STAGES } from "./demo.js";
import { packageStage } from "./package.js";
import { trainStage } from "./train.js";

export const ALL_STAGES: StagePlugin[] = [
  ...DEMO_STAGES,
  // L1 (engine): train (gp-train, rust) and package (deployable bundle)
  trainStage,
  packageStage,
];
