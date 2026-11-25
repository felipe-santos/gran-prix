// The surface the bundle installs as `window.__gpFeatures` (types only, shared by the bundle and the Node driver).
import type { ProbeOptions, RawProbe } from "./probe-types.js";
import type { SettleRecord } from "./probe/settle.js";
import type { FeatureSchemaDoc } from "./vectorize/schema.js";
import type { FeatureMatrix, FeatureSchemaLike, NodeFeaturesDoc, SnapshotLike } from "./vectorize/types.js";

export interface GpFeaturesApi {
  version: string;
  probe(options?: ProbeOptions): Promise<RawProbe>;
  settle(options?: { quietMs?: number; maxMs?: number }): Promise<SettleRecord>;
  /** The same pure functions the Node side imports. */
  vectorize(snapshot: SnapshotLike, schema: FeatureSchemaLike): NodeFeaturesDoc;
  vectorizeMatrix(snapshot: SnapshotLike, schema: FeatureSchemaLike): FeatureMatrix;
  buildFeatureSchemaV0(): FeatureSchemaDoc;
}

declare global {
  interface Window {
    __gpFeatures?: GpFeaturesApi;
  }
}
