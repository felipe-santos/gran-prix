import type { FeatureSchema } from "../feature-schema.js";
import { contractId } from "../identity/contract-ids.js";
import type { NodeFeatures } from "../node-features.js";
import type { NodeLabels } from "../node-labels.js";
import type { PageSnapshot } from "../page-snapshot.js";
import { Issues } from "./result.js";

/** Invariants of PageSnapshot, FeatureSchema, NodeFeatures, NodeLabels (shape already checked). */

export function snapshotInvariants(s: PageSnapshot): Issues {
  const out = new Issues("page-snapshot");
  s.nodes.forEach((n, i) => {
    const at = `nodes[${i}]`;
    out.check(n.idx === i, `${at}.idx`, `idx must equal its position (${i}), got ${n.idx}`);
    if (i === 0) {
      out.check(n.parent === -1, `${at}.parent`, "root must have parent -1");
      out.check(n.depth === 0, `${at}.depth`, "root must have depth 0");
    } else {
      out.check(n.parent >= 0 && n.parent < i, `${at}.parent`, `parent must be in [0, ${i - 1}] (pre-order), got ${n.parent}`);
      const p = s.nodes[n.parent];
      if (p) out.check(n.depth === p.depth + 1, `${at}.depth`, `depth must be parent depth + 1 (${p.depth + 1}), got ${n.depth}`);
    }
    out.check(n.tag === n.tag.toLowerCase(), `${at}.tag`, "tag must be lowercase");
    out.check(n.own_text.length <= n.own_text_len, `${at}.own_text_len`, "own_text_len must be >= length of own_text (it is measured BEFORE truncation)");
    out.check(n.link_text_len <= n.text_len, `${at}.link_text_len`, "link_text_len must be <= text_len");
    out.check(n.own_text_len <= n.text_len, `${at}.own_text_len`, "own_text_len must be <= text_len");
  });
  out.check(s.nodes.length > 0, "nodes", "a snapshot needs at least the root element");
  out.idCheck(s.snapshot_id === contractId("page-snapshot", s), "snapshot_id", "does not match the hash of the snapshot (excluding capture)");
  return out;
}

export function featureSchemaInvariants(s: FeatureSchema): Issues {
  const out = new Issues("feature-schema");
  out.check(s.dim === s.features.length, "dim", `dim (${s.dim}) must equal features.length (${s.features.length})`);
  const seen = new Map<string, number>();
  s.features.forEach((f, i) => {
    const at = `features[${i}]`;
    out.check(f.index === i, `${at}.index`, `index must equal its position (${i}), got ${f.index}`);
    const prev = seen.get(f.name);
    if (prev !== undefined) out.invariant(`${at}.name`, `duplicate feature name "${f.name}" (also features[${prev}])`);
    seen.set(f.name, i);
    const [lo, hi] = f.range;
    out.check(lo <= hi, `${at}.range`, `range lo (${lo}) must be <= hi (${hi})`);
    out.check(lo <= f.default && f.default <= hi, `${at}.default`, `default (${f.default}) must lie within range [${lo}, ${hi}]`);
    if (f.transform.op === "clip") out.check(f.transform.lo <= f.transform.hi, `${at}.transform`, "clip lo must be <= hi");
    if (f.transform.op === "div") out.check(f.transform.by !== 0, `${at}.transform.by`, "divisor must be non-zero");
    out.check(f.kind !== "onehot" || f.onehot !== undefined, `${at}.onehot`, 'kind "onehot" requires the onehot field');
    out.check(f.kind !== "hash_bucket" || f.hash !== undefined, `${at}.hash`, 'kind "hash_bucket" requires the hash field');
    if (f.kind === "bool") out.check(lo >= 0 && hi <= 1, `${at}.range`, 'kind "bool" must have range within [0, 1]');
  });
  const ruleIds = s.prefilter.rules.map((r) => r.id);
  ruleIds.forEach((id, i) => out.check(ruleIds.indexOf(id) === i, `prefilter.rules[${i}].id`, `duplicate prefilter rule id "${id}"`));
  out.idCheck(s.schema_id === contractId("feature-schema", s), "schema_id", "does not match the hash of the schema (excluding schema_id, description and feature docs)");
  return out;
}

export function nodeFeaturesInvariants(f: NodeFeatures): Issues {
  const out = new Issues("node-features");
  out.check(f.x.length === f.unit_ids.length, "x", `x has ${f.x.length} rows but unit_ids has ${f.unit_ids.length}`);
  f.unit_ids.forEach((u, i) => {
    if (i > 0) out.check(u > (f.unit_ids[i - 1] as number), `unit_ids[${i}]`, "unit_ids must be strictly increasing");
  });
  const dim = f.x[0]?.length ?? 0;
  f.x.forEach((row, r) => {
    out.check(row.length === dim, `x[${r}]`, `row has ${row.length} values, expected ${dim} (all rows must have the same dim)`);
    row.forEach((v, c) => out.check(Math.fround(v) === v, `x[${r}][${c}]`, `${v} is not a float32 value (apply Math.fround before serializing)`));
  });
  out.check(f.unit_ids.length <= f.n_nodes_total, "unit_ids", "more rows than n_nodes_total");
  out.idCheck(f.features_id === contractId("node-features", f), "features_id", "does not match the hash of the document");
  return out;
}

export function nodeLabelsInvariants(l: NodeLabels): Issues {
  const out = new Issues("node-labels");
  const nClasses = l.label_space.classes.length;
  l.items.forEach((it, i) => {
    out.check(it.y < nClasses, `items[${i}].y`, `class index ${it.y} outside label space (${nClasses} classes)`);
    if (i > 0) out.check(it.unit_id > (l.items[i - 1] as { unit_id: number }).unit_id, `items[${i}].unit_id`, "items must be sorted by unit_id, without duplicates");
  });
  out.check(l.coverage.n_labeled === l.items.length, "coverage.n_labeled", `must equal items.length (${l.items.length})`);
  out.check(l.coverage.n_labeled <= l.coverage.n_candidates, "coverage", "n_labeled must be <= n_candidates");
  if (l.labeler.kind === "merge") out.check((l.labeler.inputs?.length ?? 0) > 0, "labeler.inputs", "a merge labeler must list its input labels_ids");
  if (l.labeler.kind === "llm") out.check(l.labeler.llm !== undefined, "labeler.llm", 'a labeler of kind "llm" must record model, prompt and response cache keys');
  out.idCheck(l.labels_id === contractId("node-labels", l), "labels_id", "does not match the hash of the document");
  return out;
}
