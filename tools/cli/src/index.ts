export { main, processIo, type Io } from "./main.js";
export { checkPipeline, runPipeline, type PipelineCheck, type RunOptions } from "./runner.js";
export { BudgetExceededError, Ledger, type LedgerEntry, type Reservation, type SpendContext } from "./ledger.js";
export { ArtifactStore, type ArtifactHandle, type ArtifactMeta, type StageValue } from "./store.js";
export { defineStage, implVersion, StageRegistry, type StageContext, type StageLedger, type StageOutputs, type StagePlugin } from "./stage.js";
export { DEMO_STAGES } from "./stages/demo.js";
export { lineageOf, type LineageNode } from "./lineage.js";
export { dataPaths, shortId } from "./paths.js";
// The reader of the SnapshotSet artifact (collect writes it; the Studio, the label and the dataset stages read it). It is defined in
// @gran-prix/labels, which both sides already depend on; this is the same class, exported where the cli users look for it.
export { SnapshotSetReader, type SnapshotSetEntry, type SnapshotSetManifest } from "./stages/collect/snapshot-set.js";
export { dependenciesOf, select, topologicalOrder, type Selection } from "./graph.js";
export {
  PipelineValidationError,
  type CacheEntry,
  type PortIds,
  type RunSummary,
  type StageReceipt,
  type StageResult,
  type StageStatus,
} from "./types.js";
export { GP_VERSION } from "./version.js";
