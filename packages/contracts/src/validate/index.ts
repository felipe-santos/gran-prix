import type { ContentTree } from "../content-tree.js";
import type { DatasetManifest, DatasetRow } from "../dataset.js";
import type { EvalReport } from "../eval-report.js";
import type { FeatureSchema } from "../feature-schema.js";
import type { Golden } from "../golden.js";
import type { ModelPackage } from "../model-package.js";
import type { NetworkDef } from "../network-def.js";
import type { NodeFeatures } from "../node-features.js";
import type { NodeLabels } from "../node-labels.js";
import type { PageSnapshot } from "../page-snapshot.js";
import type { PipelineSpec } from "../pipeline-spec.js";
import { contractByName, UNENVELOPED, type ContractName } from "../registry.js";
import type { StageKindSpec } from "../stage-kind-spec.js";
import type { TrainConfig } from "../train-config.js";
import { contentTreeInvariants, pipelineStructureIssues } from "./inv-graph.js";
import { evalReportInvariants, goldenInvariants, modelPackageInvariants } from "./inv-model.js";
import { datasetInvariants, datasetRowInvariants, trainConfigInvariants } from "./inv-train.js";
import { featureSchemaInvariants, nodeFeaturesInvariants, nodeLabelsInvariants, snapshotInvariants } from "./inv-extract.js";
import { ContractError, type ContractIssue, type Issues, type ValidationResult } from "./result.js";
import { checkSchema } from "./schema-check.js";
import { checkFormatVersion } from "./version.js";

/** Static type of the document validated under each contract name. */
export interface ContractTypes {
  "page-snapshot": PageSnapshot;
  "feature-schema": FeatureSchema;
  "node-features": NodeFeatures;
  "node-labels": NodeLabels;
  "dataset-manifest": DatasetManifest;
  "dataset-row": DatasetRow;
  "network-def": NetworkDef;
  "train-config": TrainConfig;
  "model-package": ModelPackage;
  golden: Golden;
  "eval-report": EvalReport;
  "content-tree": ContentTree;
  "pipeline-spec": PipelineSpec;
  "stage-kind-spec": StageKindSpec;
}

type InvariantFn = (doc: never) => Issues;
const INVARIANTS: Partial<Record<ContractName, InvariantFn>> = {
  "page-snapshot": snapshotInvariants,
  "feature-schema": featureSchemaInvariants,
  "node-features": nodeFeaturesInvariants,
  "node-labels": nodeLabelsInvariants,
  "dataset-manifest": datasetInvariants,
  "dataset-row": datasetRowInvariants,
  "train-config": trainConfigInvariants,
  "model-package": modelPackageInvariants,
  golden: goldenInvariants,
  "eval-report": evalReportInvariants,
  "content-tree": contentTreeInvariants,
  "pipeline-spec": pipelineStructureIssues,
};

/**
 * Validates `value` against a contract, in this order, stopping at the first
 * stage that fails:
 *  1. `format` / `format_version` (unknown MAJOR is refused; a newer MINOR is accepted);
 *  2. JSON Schema (shape);
 *  3. invariants JSON Schema cannot express, including content-id recomputation.
 * Never "repairs" the document. Every issue carries the field `path`.
 */
export function validate<N extends ContractName>(name: N, value: unknown): ValidationResult<ContractTypes[N]> {
  if (!UNENVELOPED.has(name)) {
    const v = checkFormatVersion(name, value);
    if (v.length > 0) return { ok: false, issues: v };
  }
  const shape = checkSchema(name, value);
  if (shape.length > 0) return { ok: false, issues: shape };
  const inv = INVARIANTS[name];
  const issues: ContractIssue[] = inv ? inv(value as never).list : [];
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: value as ContractTypes[N], issues: [] };
}

/** Like `validate`, but returns the typed value or throws a `ContractError`. */
export function assertValid<N extends ContractName>(name: N, value: unknown): ContractTypes[N] {
  const r = validate(name, value);
  if (!r.ok) throw new ContractError(contractByName(name).name, r.issues);
  return r.value;
}

export { ContractError } from "./result.js";
export type { ContractIssue, IssueCode, ValidationResult } from "./result.js";
export { resolveVars, pipelineRegistryIssues } from "./pipeline.js";
export { checkFormatVersion, compareVersions, parseSemVer } from "./version.js";
