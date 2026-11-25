import type { StagePlugin } from "../stage.js";
import { collect } from "./data-collect.js";
import { extract } from "./data-extract.js";

/** E1.5: the real data stages. Importing this module does not load Playwright (both stages import it on demand). */
export const COLLECT_STAGES: readonly StagePlugin[] = [collect, extract];

export { collect, extract };
export { SnapshotSetReader, type SnapshotSetEntry, type SnapshotSetManifest } from "./collect/snapshot-set.js";
export { NodeFeaturesSetReader, type NodeFeaturesSetEntry, type NodeFeaturesSetManifest } from "./collect/features-set.js";
export { parseUrlList, type UrlEntry } from "./collect/url-list.js";
