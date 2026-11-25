import type { StagePlugin } from "../stage.js";
import { DATASET_STAGES } from "./dataset.js";
import { LABEL_STAGES } from "./label.js";

/** Lane L4b: the `label` and `dataset` stages. One entry for `stages/index.ts`. */
export const LABELING_STAGES: readonly StagePlugin[] = [...LABEL_STAGES, ...DATASET_STAGES];
