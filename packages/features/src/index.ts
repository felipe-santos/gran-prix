// Node entry. The in-page code is NOT imported here: it ships as dist/gp-features.iife.js
// (see ./browser.ts); the pure vectorizer is shared by both.
import featureSchemaV0Json from "./schema/feature-schema.v0.json" with { type: "json" };
import type { FeatureSchemaLike } from "./vectorize/types.js";

export * from "./vectorize/index.js";
export * from "./probe-types.js";
export { buildPageSnapshot, defaultGroupKey, defaultUrlKey, type BuildSnapshotOptions, type CaptureMeta, type PageSnapshotDoc } from "./node/snapshot.js";
export { bundlePath, bundleSource, findChromium, launch, probeLoadedPage, type Launched, type ProbePageOptions, type ProbedPage } from "./node/driver.js";

/** The committed FeatureSchema v0 (a `gran-prix.feature-schema` document). */
export const featureSchemaV0 = featureSchemaV0Json as unknown as FeatureSchemaLike & { format: string; format_version: string };
