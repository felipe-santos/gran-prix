import type { EvalReport } from "../eval-report.js";
import type { Golden } from "../golden.js";
import { contractId, modelId } from "../identity/contract-ids.js";
import type { ModelPackage } from "../model-package.js";
import { Issues } from "./result.js";

export function modelPackageInvariants(m: ModelPackage): Issues {
  const out = new Issues("model-package");
  const { feature_spec: fs, output_spec: os, network: net, thresholds: th } = m;

  out.check(net.input_dim === fs.dim, "network.input_dim", `network.input_dim (${net.input_dim}) must equal feature_spec.dim (${fs.dim})`);
  out.check(fs.names.length === fs.dim, "feature_spec.names", `names has ${fs.names.length} entries, dim is ${fs.dim}`);
  out.check(new Set(fs.names).size === fs.names.length, "feature_spec.names", "feature names must be unique");
  if (fs.normalization.kind === "zscore") {
    const z = fs.normalization;
    out.check(z.mean.length === fs.dim, "feature_spec.normalization.mean", `mean has ${z.mean.length} entries, dim is ${fs.dim}`);
    out.check(z.std.length === fs.dim, "feature_spec.normalization.std", `std has ${z.std.length} entries, dim is ${fs.dim}`);
    z.std.forEach((s, i) => out.check(s >= 0, `feature_spec.normalization.std[${i}]`, "std must be >= 0"));
  }
  out.check(fs.ood.lo.length === fs.dim, "feature_spec.ood.lo", `lo has ${fs.ood.lo.length} entries, dim is ${fs.dim}`);
  out.check(fs.ood.hi.length === fs.dim, "feature_spec.ood.hi", `hi has ${fs.ood.hi.length} entries, dim is ${fs.dim}`);
  fs.ood.lo.forEach((lo, i) => {
    const hi = fs.ood.hi[i];
    if (hi !== undefined) out.check(lo <= hi, `feature_spec.ood.lo[${i}]`, `lo (${lo}) must be <= hi (${hi})`);
  });

  out.check(th.escalate <= th.accept, "thresholds.escalate", `escalate (${th.escalate}) must be <= accept (${th.accept})`);

  if (os.activation === "sigmoid") {
    out.check(net.output_dim === 1, "network.output_dim", "sigmoid output needs a single logit (output_dim 1)");
    out.check(os.labels.length === 2, "output_spec.labels", "sigmoid output needs exactly 2 labels [negative, positive]");
    out.check(os.calibration.kind !== "temperature", "output_spec.calibration", "temperature scaling is for softmax outputs; use platt for sigmoid");
  } else {
    out.check(os.labels.length === net.output_dim, "output_spec.labels", `${os.labels.length} labels but output_dim is ${net.output_dim}`);
    out.check(os.calibration.kind !== "platt", "output_spec.calibration", "platt scaling is for a single sigmoid logit; use temperature for softmax");
  }
  out.check(new Set(os.labels).size === os.labels.length, "output_spec.labels", "labels must be unique");

  // Weight layout: contiguous, sizes consistent with shapes and with the file.
  let offset = 0;
  m.network.param_layout.forEach((p, i) => {
    const at = `network.param_layout[${i}]`;
    const size = p.shape.reduce((a, b) => a * b, 1);
    out.check(p.length === size, `${at}.length`, `length ${p.length} != product of shape [${p.shape.join(", ")}] = ${size}`);
    out.check(p.offset === offset, `${at}.offset`, `offset ${p.offset} breaks contiguity (expected ${offset})`);
    offset = p.offset + p.length;
  });
  const w = m.files.weights;
  out.check(w.count === offset, "files.weights.count", `count ${w.count} != sum of param_layout lengths ${offset}`);
  out.check(w.bytes === w.count * 4, "files.weights.bytes", `bytes ${w.bytes} != count * 4 = ${w.count * 4}`);
  out.check(m.files.network_def.path === "network_def.json", "files.network_def.path", 'must be "network_def.json"');
  out.check(w.path === "weights.f32le", "files.weights.path", 'must be "weights.f32le"');
  out.check(m.files.golden.path === "golden.json", "files.golden.path", 'must be "golden.json"');
  out.check(m.requires.layer_types.length > 0, "requires.layer_types", "must list the layer types the network uses");

  out.idCheck(m.model_id === modelId(m), "model_id", "does not match the behavior hash (digest.network_def, digest.weights, task, feature_spec, output_spec, thresholds, requires)");
  return out;
}

export function goldenInvariants(g: Golden): Issues {
  const out = new Issues("golden");
  const dim = g.cases[0]?.input.length ?? 0;
  const outDim = g.cases[0]?.raw.length ?? 0;
  g.cases.forEach((c, i) => {
    out.check(c.input.length === dim, `cases[${i}].input`, `has ${c.input.length} values, expected ${dim}`);
    out.check(c.raw.length === outDim, `cases[${i}].raw`, `has ${c.raw.length} values, expected ${outDim}`);
    out.check(c.score.length === outDim, `cases[${i}].score`, `has ${c.score.length} values, expected ${outDim}`);
  });
  return out;
}

export function evalReportInvariants(r: EvalReport): Issues {
  const out = new Issues("eval-report");
  out.check(r.mode !== "intrinsic" || r.intrinsic !== undefined, "intrinsic", 'mode "intrinsic" requires the intrinsic section');
  out.check(r.mode !== "downstream" || r.downstream !== undefined, "downstream", 'mode "downstream" requires the downstream section');
  if (typeof r.split === "object") out.check(r.split.kfold.fold < r.split.kfold.k, "split.kfold.fold", "fold must be < k");

  const prf = (p: { n: number; tp: number; fp: number; tn: number; fn: number }, at: string): void =>
    out.check(p.tp + p.fp + p.tn + p.fn === p.n, at, `tp+fp+tn+fn (${p.tp + p.fp + p.tn + p.fn}) must equal n (${p.n})`);
  const i = r.intrinsic;
  if (i) {
    prf(i.overall, "intrinsic.overall");
    for (const [k, v] of Object.entries(i.by_stratum)) prf(v, `intrinsic.by_stratum.${k}`);
    for (const [k, v] of Object.entries(i.by_label_source)) prf(v, `intrinsic.by_label_source.${k}`);
    for (const [k, b] of Object.entries(i.baselines)) prf(b.overall, `intrinsic.baselines.${k}.overall`);
    i.comparison.forEach((c, j) => {
      const at = `intrinsic.comparison[${j}]`;
      out.check(c.ci95[0] <= c.ci95[1], `${at}.ci95`, "ci95 must be [lo, hi] with lo <= hi");
      out.check(Math.abs(c.model - c.baseline_value - c.delta) < 1e-9, `${at}.delta`, "delta must equal model - baseline_value");
      out.check(c.baseline in i.baselines, `${at}.baseline`, `baseline "${c.baseline}" is not in intrinsic.baselines`);
      out.check(c.stratum in i.by_stratum, `${at}.stratum`, `stratum "${c.stratum}" is not in intrinsic.by_stratum`);
    });
  }
  const d = r.downstream;
  if (d) {
    d.paired_deltas.forEach((p, j) => {
      out.check(p.ci95[0] <= p.ci95[1], `downstream.paired_deltas[${j}].ci95`, "ci95 must be [lo, hi] with lo <= hi");
      out.check(p.a in d.arms, `downstream.paired_deltas[${j}].a`, `arm "${p.a}" is not in downstream.arms`);
      out.check(p.b in d.arms, `downstream.paired_deltas[${j}].b`, `arm "${p.b}" is not in downstream.arms`);
    });
    for (const [k, arm] of Object.entries(d.arms)) out.check(arm.score_ci95[0] <= arm.score_ci95[1], `downstream.arms.${k}.score_ci95`, "ci95 must be [lo, hi] with lo <= hi");
  }
  const gateIds = (r.gates ?? []).map((g) => g.id);
  gateIds.forEach((id, j) => out.check(gateIds.indexOf(id) === j, `gates[${j}].id`, `duplicate gate id "${id}"`));
  out.idCheck(r.report_id === contractId("eval-report", r), "report_id", "does not match the hash of the report (excluding report_id and provenance)");
  return out;
}
