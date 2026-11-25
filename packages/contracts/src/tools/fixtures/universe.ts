import type { ContractName } from "../../registry.js";
import { buildNodeFeatures, buildFeatureSchema, buildNodeLabels, buildSnapshot } from "./extract-docs.js";
import { buildDataset, buildTrainConfig, sealDataset, type DatasetFixture } from "./data-docs.js";
import { buildContentTree, buildPipeline, buildStageKinds } from "./graph-docs.js";
import { buildEvalReport, buildModel, type ModelFixture } from "./model-docs.js";
import type { ContentTree } from "../../content-tree.js";
import type { DatasetManifest, DatasetRow } from "../../dataset.js";
import type { EvalReport } from "../../eval-report.js";
import type { FeatureSchema } from "../../feature-schema.js";
import type { ModelPackage } from "../../model-package.js";
import type { NodeFeatures } from "../../node-features.js";
import type { NodeLabels } from "../../node-labels.js";
import type { PageSnapshot } from "../../page-snapshot.js";
import type { PipelineSpec } from "../../pipeline-spec.js";
import type { StageKindSpec } from "../../stage-kind-spec.js";
import type { TrainConfig } from "../../train-config.js";
import type { NetworkDef } from "../../network-def.js";
import type { Golden } from "../../golden.js";
import { NETWORK_DEF } from "./data-docs.js";

/** Every valid document of the fixture universe, mutually consistent (ids, dims, hashes). */
export interface Universe {
  snapshot: PageSnapshot;
  schema: FeatureSchema;
  features: NodeFeatures;
  labels: NodeLabels;
  dataset: DatasetFixture & { manifest: DatasetManifest };
  datasetRow: DatasetRow;
  networkDef: NetworkDef;
  trainConfig: TrainConfig;
  modelFixture: ModelFixture;
  model: ModelPackage;
  golden: Golden;
  evalReport: EvalReport;
  contentTree: ContentTree;
  pipeline: PipelineSpec;
  stageKinds: StageKindSpec[];
}

export function buildUniverse(): Universe {
  const snapshot = buildSnapshot();
  const schema = buildFeatureSchema();
  const features = buildNodeFeatures(snapshot, schema);
  const labels = buildNodeLabels(snapshot);
  const ds = buildDataset();
  ds.manifest = sealDataset({ ...ds.manifest, feature_schema_id: schema.schema_id });
  const modelFixture = buildModel(schema);
  const evalReport = buildEvalReport(modelFixture.model, ds.manifest.dataset_id);
  const model: ModelPackage = {
    ...modelFixture.model,
    metrics: { eval_report_id: evalReport.report_id, headline: { f1: evalReport.intrinsic?.overall.f1 ?? 0 } },
  };
  return {
    snapshot,
    schema,
    features,
    labels,
    dataset: ds,
    datasetRow: ds.rows[0] as DatasetRow,
    networkDef: NETWORK_DEF,
    trainConfig: buildTrainConfig(),
    modelFixture,
    model,
    golden: modelFixture.golden,
    evalReport,
    contentTree: buildContentTree(model.model_id, schema.schema_id, snapshot.snapshot_id),
    pipeline: buildPipeline(),
    stageKinds: buildStageKinds(),
  };
}

/** Where each contract's valid fixture lives, relative to `fixtures/valid/`. */
export const VALID_PATH: Record<ContractName, string> = {
  "page-snapshot": "page-snapshot.json",
  "feature-schema": "feature-schema.json",
  "node-features": "node-features.json",
  "node-labels": "node-labels.json",
  "dataset-manifest": "dataset/manifest.json",
  "dataset-row": "dataset-row.json",
  "network-def": "model-package/network_def.json",
  "train-config": "train-config.json",
  "model-package": "model-package/model.json",
  golden: "model-package/golden.json",
  "eval-report": "eval-report.json",
  "content-tree": "content-tree.json",
  "pipeline-spec": "pipeline-spec.json",
  "stage-kind-spec": "stage-kind-spec.json",
};

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** Every file of `fixtures/valid/`, by relative path. */
export function validFiles(u: Universe): Map<string, string | Uint8Array> {
  const f = new Map<string, string | Uint8Array>();
  f.set(VALID_PATH["page-snapshot"], json(u.snapshot));
  f.set(VALID_PATH["feature-schema"], json(u.schema));
  f.set(VALID_PATH["node-features"], json(u.features));
  f.set(VALID_PATH["node-labels"], json(u.labels));
  f.set(VALID_PATH["dataset-manifest"], json(u.dataset.manifest));
  f.set("dataset/train.jsonl", u.dataset.files.train);
  f.set("dataset/val.jsonl", u.dataset.files.val);
  f.set("dataset/test.jsonl", u.dataset.files.test);
  f.set(VALID_PATH["dataset-row"], json(u.datasetRow));
  f.set(VALID_PATH["train-config"], json(u.trainConfig));
  f.set(VALID_PATH["model-package"], json(u.model));
  f.set("model-package/network_def.json", u.modelFixture.networkDefText);
  f.set("model-package/weights.f32le", u.modelFixture.weightsBytes);
  f.set(VALID_PATH.golden, u.modelFixture.goldenText);
  f.set(VALID_PATH["eval-report"], json(u.evalReport));
  f.set(VALID_PATH["content-tree"], json(u.contentTree));
  f.set(VALID_PATH["pipeline-spec"], json(u.pipeline));
  f.set(VALID_PATH["stage-kind-spec"], json(u.stageKinds.find((k) => k.kind === "label")));
  f.set("pipeline-registry.json", json(u.stageKinds));
  return f;
}
