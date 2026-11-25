/**
 * Single registration point for every stage plugin the `gp` CLI knows.
 *
 * Each lane adds its stages here: one import line and one spread entry.
 * Keep the list ordered by lane so parallel merges stay trivial.
 */
import type { StagePlugin } from "../stage.js";
import { DEMO_STAGES } from "./demo.js";
import { LABELING_STAGES } from "./labeling.js";

export const ALL_STAGES: StagePlugin[] = [
  ...DEMO_STAGES,
  ...LABELING_STAGES,
];
