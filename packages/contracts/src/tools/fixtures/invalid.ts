/**
 * Invalid fixtures: each is a valid document with ONE deliberate defect and the
 * issue the validator must report (code + field path [+ message fragment]).
 * Ids are re-sealed after the mutation unless the defect IS a stale id, so a
 * case exercises exactly the rule it names.
 */
import { contractId, modelId } from "../../identity/contract-ids.js";
import type { IssueCode } from "../../validate/result.js";
import type { ContractName } from "../../registry.js";
import type { Universe } from "./universe.js";
import { sha } from "./extract-docs.js";
import { buildInvalidCasesV11 } from "./invalid-v11.js";

export interface InvalidCase {
  /** File under fixtures/invalid/. */
  file: string;
  contract: ContractName;
  doc: unknown;
  expect: { code: IssueCode; path: string; message?: string };
}

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const clone = <T>(v: T): T => structuredClone(v);

export function buildInvalidCases(u: Universe): InvalidCase[] {
  const cases: InvalidCase[] = [];
  const add = (
    contract: ContractName,
    name: string,
    doc: unknown,
    code: IssueCode,
    path: string,
    message?: string,
  ): void => {
    cases.push({ file: `${contract}.${name}.json`, contract, doc, expect: { code, path, ...(message ? { message } : {}) } });
  };
  const reid = (contract: Parameters<typeof contractId>[0], idField: string, d: Doc): Doc => ({ ...d, [idField]: contractId(contract, d) });

  // --- page-snapshot
  {
    const d: Doc = clone(u.snapshot);
    d["nodes"][1].idx = 5;
    add("page-snapshot", "bad-idx", reid("page-snapshot", "snapshot_id", d), "invariant", "nodes[1].idx", "position");
    const e: Doc = clone(u.snapshot);
    e["nodes"][3].parent = 3;
    add("page-snapshot", "self-parent", reid("page-snapshot", "snapshot_id", e), "invariant", "nodes[3].parent", "pre-order");
    const f: Doc = clone(u.snapshot);
    delete f["html"];
    add("page-snapshot", "missing-html", f, "schema", "html", "required");
    const g: Doc = clone(u.snapshot);
    g["format_version"] = "2.0.0";
    add("page-snapshot", "unknown-major", g, "version", "format_version", "MAJOR");
    const h: Doc = clone(u.snapshot);
    h["page"]["category"] = "tampered";
    add("page-snapshot", "stale-id", h, "id-mismatch", "snapshot_id");
  }
  // --- feature-schema
  {
    const d: Doc = clone(u.schema);
    d["features"][2].name = d["features"][1].name;
    add("feature-schema", "duplicate-name", reid("feature-schema", "schema_id", d), "invariant", "features[2].name", "duplicate");
    const e: Doc = clone(u.schema);
    e["features"][1].index = 2;
    add("feature-schema", "index-out-of-order", reid("feature-schema", "schema_id", e), "invariant", "features[1].index");
    const f: Doc = clone(u.schema);
    f["features"][1].name = "LinkDensity";
    add("feature-schema", "bad-name-pattern", f, "schema", "features[1].name", "pattern");
    const g: Doc = clone(u.schema);
    g["features"][0].transform.scale = 20;
    add("feature-schema", "stale-id", g, "id-mismatch", "schema_id");
    const h: Doc = clone(u.schema);
    h["features"][3].default = 5;
    add("feature-schema", "default-out-of-range", reid("feature-schema", "schema_id", h), "invariant", "features[3].default", "range");
    const i: Doc = clone(u.schema);
    i["format"] = "gran-prix.page-snapshot";
    add("feature-schema", "wrong-format", i, "version", "format");
  }
  // --- node-features
  {
    const d: Doc = clone(u.features);
    d["x"][0][1] = 0.3;
    add("node-features", "x-not-float32", reid("node-features", "features_id", d), "invariant", "x[0][1]", "float32");
    const e: Doc = clone(u.features);
    e["unit_ids"] = [3, 2, 4];
    add("node-features", "unit-ids-not-increasing", reid("node-features", "features_id", e), "invariant", "unit_ids[1]", "increasing");
    const f: Doc = clone(u.features);
    f["x"][1] = f["x"][1].slice(0, 3);
    add("node-features", "ragged-row", reid("node-features", "features_id", f), "invariant", "x[1]", "dim");
  }
  // --- node-labels
  {
    const d: Doc = clone(u.labels);
    d["items"][1].y = 7;
    add("node-labels", "y-out-of-space", reid("node-labels", "labels_id", d), "invariant", "items[1].y", "outside label space");
    const e: Doc = clone(u.labels);
    e["items"][1].confidence = 1.5;
    add("node-labels", "confidence-over-one", e, "schema", "items[1].confidence");
    const f: Doc = clone(u.labels);
    f["items"][0].source = "oracle";
    add("node-labels", "unknown-source", f, "schema", "items[0].source");
  }
  // --- dataset-manifest
  {
    const m = u.dataset.manifest;
    const reidM = (d: Doc): Doc => reid("dataset-manifest", "dataset_id", d);
    const a = m.groups[0] as { split: string };
    const jIdx = m.groups.findIndex((g) => g.split !== a.split);
    const d: Doc = clone(m);
    d["groups"][jIdx].group_key = d["groups"][0].group_key;
    add("dataset-manifest", "leakage", reidM(d), "invariant", `groups[${jIdx}].split`, "LEAKAGE");
    const e: Doc = clone(m);
    e["split"]["ranges"]["val"] = [72, 85];
    add("dataset-manifest", "ranges-gap", reidM(e), "invariant", "split.ranges.val", "gap or overlap");
    const f: Doc = clone(m);
    f["groups"][0].bucket += 1;
    add("dataset-manifest", "tampered-bucket", reidM(f), "invariant", "groups[0].bucket", "recomputed");
    const g: Doc = clone(m);
    g["files"]["train"].rows += 1;
    add("dataset-manifest", "rows-mismatch", reidM(g), "invariant", "files.train.rows");
    const h: Doc = clone(m);
    h["split"]["group_by"] = "domain";
    add("dataset-manifest", "unknown-group-by", h, "schema", "split.group_by");
  }
  // --- dataset-row
  {
    const d: Doc = clone(u.datasetRow);
    d["y"] = -1;
    add("dataset-row", "negative-y", d, "schema", "y");
    const e: Doc = clone(u.datasetRow);
    e["x"][0] = 0.3;
    add("dataset-row", "x-not-float32", e, "invariant", "x[0]", "float32");
  }
  // --- network-def
  {
    const d: Doc = clone(u.networkDef);
    d["layers"][0].dropout_rate = 0.5;
    add("network-def", "unknown-field", d, "schema", "layers[0]");
    const e: Doc = clone(u.networkDef);
    e["layers"][0].in_features = 0;
    add("network-def", "zero-features", e, "schema", "layers[0].in_features");
  }
  // --- train-config
  {
    const d: Doc = clone(u.trainConfig);
    d["network"] = { kind: "def", def: { input_dim: 4, layers: [{ type: "linear", in_features: 4, out_features: 3 }, { type: "batchnorm", num_features: 3 }, { type: "linear", in_features: 3, out_features: 1 }] } };
    d["runtime"] = { engine: "wasm-node" };
    d["data"]["class_balance"] = { strategy: "none" };
    delete d["train_config_id"];
    add("train-config", "batchnorm-on-wasm", d, "lint", "network.def.layers[1]", "BatchNorm");
    const e: Doc = clone(u.trainConfig);
    delete e["seed"];
    add("train-config", "missing-seed", e, "schema", "seed", "required");
    const f: Doc = clone(u.trainConfig);
    f["loss"] = "ce_logits";
    delete f["train_config_id"];
    add("train-config", "loss-mismatch", f, "invariant", "loss", "more than one");
    const g: Doc = clone(u.trainConfig);
    g["runtime"] = { engine: "wasm-node" };
    add("train-config", "pos-weight-on-wasm", reid("train-config", "train_config_id", g), "invariant", "data.class_balance.strategy", "gp-train");
  }
  // --- model-package
  {
    const reidModel = (d: Doc): Doc => ({ ...d, model_id: modelId(d as never) });
    const d: Doc = clone(u.model);
    d["thresholds"].escalate = 0.9;
    add("model-package", "thresholds-inverted", reidModel(d), "invariant", "thresholds.escalate", "<= accept");
    const e: Doc = clone(u.model);
    e["network"].input_dim = 5;
    add("model-package", "input-dim-mismatch", reidModel(e), "invariant", "network.input_dim", "feature_spec.dim");
    const f: Doc = clone(u.model);
    f["thresholds"].accept = 0.8;
    add("model-package", "stale-model-id", f, "id-mismatch", "model_id");
    const g: Doc = clone(u.model);
    g["files"].weights.count = 20;
    add("model-package", "weights-count", reidModel(g), "invariant", "files.weights.count");
    const h: Doc = clone(u.model);
    h["feature_spec"].normalization.mean = [0, 0, 0];
    add("model-package", "zscore-wrong-length", reidModel(h), "invariant", "feature_spec.normalization.mean");
    const i: Doc = clone(u.model);
    i["digest"].weights = "abc";
    add("model-package", "bad-digest-format", i, "schema", "digest.weights", "pattern");
    const j: Doc = clone(u.model);
    j["output_spec"].labels = ["only-one"];
    add("model-package", "one-label", j, "schema", "output_spec.labels");
  }
  // --- golden
  {
    const d: Doc = clone(u.golden);
    d["cases"][1].input = d["cases"][1].input.slice(0, 3);
    add("golden", "ragged-cases", d, "invariant", "cases[1].input");
    const e: Doc = clone(u.golden);
    e["weights_sha256"] = sha("x").slice(0, 20);
    add("golden", "bad-weights-sha", e, "schema", "weights_sha256");
  }
  // --- eval-report
  {
    const reidR = (d: Doc): Doc => reid("eval-report", "report_id", d);
    const d: Doc = clone(u.evalReport);
    d["intrinsic"].overall.n += 1;
    add("eval-report", "counts-dont-add-up", reidR(d), "invariant", "intrinsic.overall", "tp+fp+tn+fn");
    const e: Doc = clone(u.evalReport);
    e["intrinsic"].comparison[0].ci95 = [0.5, -0.5];
    add("eval-report", "ci-inverted", reidR(e), "invariant", "intrinsic.comparison[0].ci95");
    const f: Doc = clone(u.evalReport);
    f["mode"] = "downstream";
    add("eval-report", "mode-without-section", reidR(f), "invariant", "downstream");
    const g: Doc = clone(u.evalReport);
    g["intrinsic"].overall.f1 = 1.5;
    add("eval-report", "f1-over-one", reidR(g), "schema", "intrinsic.overall.f1");
  }
  // --- content-tree
  {
    const d: Doc = clone(u.contentTree);
    d["root"][0].level = 7;
    add("content-tree", "heading-level-7", d, "schema", "root[0]");
    const e: Doc = clone(u.contentTree);
    e["root"][2].children[1].rows[0] = ["1"];
    add("content-tree", "table-row-width", e, "invariant", "root[2].children[1].rows[0]", "cells");
    const f: Doc = clone(u.contentTree);
    f["root"][0].src = [9];
    add("content-tree", "sibling-order", f, "invariant", "root[1].src", "document order");
  }
  // --- pipeline-spec
  {
    const d: Doc = clone(u.pipeline);
    d["stages"][1].inputs.snapshots = { stage: "eval", output: "report" };
    add("pipeline-spec", "cycle", d, "invariant", "stages", "cycle");
    const e: Doc = clone(u.pipeline);
    e["stages"][2].inputs.features = { stage: "nope", output: "features" };
    add("pipeline-spec", "unknown-stage-ref", e, "invariant", "stages[2].inputs.features", "unknown stage");
    const f: Doc = clone(u.pipeline);
    f["stages"][5].id = "train";
    add("pipeline-spec", "duplicate-stage-id", f, "invariant", "stages[5].id", "duplicate");
    const g: Doc = clone(u.pipeline);
    g["stages"][0].inputs.urls = { external: "missing" };
    add("pipeline-spec", "undeclared-external", g, "invariant", "stages[0].inputs.urls", "externals");
    const h: Doc = clone(u.pipeline);
    h["stages"] = [];
    add("pipeline-spec", "no-stages", h, "schema", "stages");
  }
  // --- stage-kind-spec
  {
    const k = u.stageKinds.find((x) => x.kind === "label");
    const d: Doc = clone(k as Doc);
    d["kind"] = "frobnicate";
    add("stage-kind-spec", "unknown-kind", d, "schema", "kind");
    const e: Doc = clone(k as Doc);
    e["inputs"][0].type = "Spreadsheet";
    add("stage-kind-spec", "unknown-port-type", e, "schema", "inputs[0].type");
  }
  return [...cases, ...buildInvalidCasesV11(u)];
}
