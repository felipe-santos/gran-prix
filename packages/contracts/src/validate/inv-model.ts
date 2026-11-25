import type { Golden } from "../golden.js";
import { modelId } from "../identity/contract-ids.js";
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
