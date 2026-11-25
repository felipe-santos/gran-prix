import { artifactId, type Sha256 } from "./hash.js";

/**
 * Which top-level fields are NOT part of an artifact's identity, per contract.
 * The id field itself is always excluded. Everything else (including `format`
 * and `format_version`) is hashed. See README "ID rules".
 */
const OMITTED_FROM_ID = {
  "page-snapshot": { id: "snapshot_id", omit: ["capture"] },
  "feature-schema": { id: "schema_id", omit: ["description"] },
  "node-features": { id: "features_id", omit: [] },
  "node-labels": { id: "labels_id", omit: [] },
  "dataset-manifest": { id: "dataset_id", omit: ["provenance"] },
  "train-config": { id: "train_config_id", omit: [] },
  "eval-report": { id: "report_id", omit: ["provenance"] },
  "label-agreement": { id: "agreement_id", omit: ["provenance"] },
  "qa-task-set": { id: "task_set_id", omit: ["provenance"] },
  // PipelineSpec has no id field of its own (the id lives in Provenance.pipeline_spec_id).
  "pipeline-spec": { id: undefined, omit: ["layout"] },
} as const;

export type IdentifiedContract = keyof typeof OMITTED_FROM_ID;

function omitKeys(doc: Record<string, unknown>, keys: readonly (string | undefined)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/**
 * Identity payload of a document: the document minus its id field and minus
 * its provenance-like fields. For a feature schema the per-feature `doc`
 * strings are also dropped (documentation is not behavior).
 */
export function identityPayload(contract: IdentifiedContract, doc: Record<string, unknown>): Record<string, unknown> {
  const rule = OMITTED_FROM_ID[contract];
  const payload = omitKeys(doc, [rule.id, ...rule.omit]);
  if (contract === "feature-schema" && Array.isArray(payload["features"])) {
    payload["features"] = (payload["features"] as unknown[]).map((f) =>
      f !== null && typeof f === "object" && !Array.isArray(f) ? omitKeys(f as Record<string, unknown>, ["doc"]) : f,
    );
  }
  return payload;
}

/** Recomputes the content id of a document of the given contract. */
export function contractId(contract: IdentifiedContract, doc: Record<string, unknown>): Sha256 {
  return artifactId(identityPayload(contract, doc));
}

/** The name of the id field of a contract (e.g. `schema_id`), if it has one. */
export function idFieldOf(contract: IdentifiedContract): string | undefined {
  return OMITTED_FROM_ID[contract].id;
}

/** Subset of `model.json` that `modelId` reads. */
export interface ModelIdSource {
  digest: { network_def: Sha256; weights: Sha256 };
  task: unknown;
  feature_spec: unknown;
  output_spec: unknown;
  thresholds: unknown;
  requires: unknown;
}

/**
 * `model_id` (ADR-003): identity = behavior. Hash of
 *
 *     { v: "gran-prix.model-id/1", digest: { network_def, weights },
 *       task, feature_spec, output_spec, thresholds, requires }
 *
 * Explicitly NOT hashed: `name`, `description`, `metrics`, `provenance`,
 * `golden` digest, file paths/sizes, `format_version`, and `model_id` itself.
 * Changing a threshold, the calibration, the normalization or one weight
 * changes the id; re-running the evaluation or re-training on another machine
 * to byte-identical weights does not. The leading `v` versions the formula
 * itself (changing it is a MAJOR change of the model-package contract).
 */
export function modelId(model: ModelIdSource): Sha256 {
  return artifactId({
    v: "gran-prix.model-id/1",
    digest: { network_def: model.digest.network_def, weights: model.digest.weights },
    task: model.task,
    feature_spec: model.feature_spec,
    output_spec: model.output_spec,
    thresholds: model.thresholds,
    requires: model.requires,
  });
}
