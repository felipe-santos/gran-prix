import { ContentTreeContract } from "./content-tree.js";
import { DatasetManifestContract, DatasetRowContract } from "./dataset.js";
import { EvalReportContract } from "./eval-report.js";
import { FeatureSchemaContract } from "./feature-schema.js";
import { GoldenContract } from "./golden.js";
import { ModelPackageContract } from "./model-package.js";
import { NetworkDefContract } from "./network-def.js";
import { NodeFeaturesContract } from "./node-features.js";
import { NodeLabelsContract } from "./node-labels.js";
import { PageSnapshotContract } from "./page-snapshot.js";
import { PipelineSpecContract } from "./pipeline-spec.js";
import { StageKindSpecContract } from "./stage-kind-spec.js";
import { TrainConfigContract } from "./train-config.js";

/** Every contract, in the order they are documented. One JSON Schema file each. */
export const CONTRACTS = [
  PageSnapshotContract,
  FeatureSchemaContract,
  NodeFeaturesContract,
  NodeLabelsContract,
  DatasetManifestContract,
  DatasetRowContract,
  NetworkDefContract,
  TrainConfigContract,
  ModelPackageContract,
  GoldenContract,
  EvalReportContract,
  ContentTreeContract,
  PipelineSpecContract,
  StageKindSpecContract,
] as const;

export type ContractName = (typeof CONTRACTS)[number]["name"];
export const CONTRACT_NAMES = CONTRACTS.map((c) => c.name) as ContractName[];

/**
 * Contracts WITHOUT the `format` / `format_version` envelope: single JSONL
 * rows and the Rust core's own NetworkDef JSON. Their version is the
 * contract's, tracked in the registry and the schema file name only.
 */
export const UNENVELOPED: ReadonlySet<ContractName> = new Set<ContractName>(["dataset-row", "network-def"]);

export function contractByName(name: ContractName) {
  const c = CONTRACTS.find((x) => x.name === name);
  if (!c) throw new Error(`unknown contract: ${name}`);
  return c;
}
