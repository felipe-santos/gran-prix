/**
 * Single registration point for every stage plugin the `gp` CLI knows.
 *
 * Each lane adds its stages here: one import line and one spread entry.
 * Keep the list ordered by lane so parallel merges stay trivial.
 */
import type { StagePlugin } from "../stage.js";
import { COLLECT_STAGES } from "./collect-stages.js";
import { DEMO_STAGES } from "./demo.js";
import { EVALUATE_STAGES } from "./evaluate/index.js";

export const ALL_STAGES: StagePlugin[] = [
  ...DEMO_STAGES,
  ...EVALUATE_STAGES,
  ...COLLECT_STAGES,
];
