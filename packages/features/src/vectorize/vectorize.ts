// vectorize(snapshot, schema) -> NodeFeatures. PURE: a function of its two arguments only. No Date, no
// randomness, no DOM, no I/O; all floats pass through Math.fround; runs bit-identically in Node and in
// Chromium (the same source is bundled into the in-page IIFE).
import { derive } from "./derive.js";
import { FEATURE_BY_NAME, type FeatureSpec } from "./features.js";
import { artifactId } from "./hash.js";
import { VectorizeError, type FeatureDefLike, type FeatureMatrix, type FeatureSchemaLike, type NodeFeaturesDoc, type SnapshotLike, type StaticTransformLike } from "./types.js";

function applyTransform(t: StaticTransformLike, raw: number): number {
  switch (t.op) {
    case "none": return raw;
    case "log1p": return Math.log1p(raw) / Math.log1p(t.scale);
    case "clip": return Math.min(Math.max(raw, t.lo), t.hi);
    case "div": return raw / t.by;
  }
}

function resolve(schema: FeatureSchemaLike): { def: FeatureDefLike; spec: FeatureSpec }[] {
  if (schema.dim !== schema.features.length) throw new VectorizeError(`schema.dim (${schema.dim}) != features.length (${schema.features.length})`);
  return schema.features.map((def, i) => {
    if (def.index !== i) throw new VectorizeError(`feature "${def.name}" has index ${def.index}, expected ${i}`);
    const spec = FEATURE_BY_NAME.get(def.name);
    if (!spec) throw new VectorizeError(`unknown feature "${def.name}": this extractor does not implement it`);
    if (!!spec.context !== !!def.context) throw new VectorizeError(`feature "${def.name}": context declaration differs from the implementation`);
    return { def, spec };
  });
}

/** Numeric core: a row-major Float32Array plus the bookkeeping counts of NodeFeatures. */
export function vectorizeMatrix(snapshot: SnapshotLike, schema: FeatureSchemaLike): FeatureMatrix {
  const feats = resolve(schema);
  const dim = feats.length;
  const ctx = derive(snapshot, schema);

  const unitIds: number[] = [];
  const rowOf = new Int32Array(ctx.n).fill(-1);
  for (let i = 0; i < ctx.n; i++) {
    if (ctx.dropped[i] === 0) { rowOf[i] = unitIds.length; unitIds.push(i); }
  }
  const prefiltered: Record<string, number> = {};
  for (const r of schema.prefilter.rules) prefiltered[r.id] = 0;
  for (let i = 0; i < ctx.n; i++) {
    const r = ctx.droppedBy[i] as number;
    if (r >= 0) { const id = (schema.prefilter.rules[r] as { id: string }).id; prefiltered[id] = (prefiltered[id] ?? 0) + 1; }
  }

  const x = new Float32Array(unitIds.length * dim);
  let nanReplaced = 0;
  let clipped = 0;
  const sanitize = (v: number, def: FeatureDefLike): number => {
    let y = v;
    if (Number.isNaN(y)) { y = 0; nanReplaced++; }
    const [lo, hi] = def.range;
    if (y < lo) { y = lo; clipped++; } else if (y > hi) { y = hi; clipped++; }
    return y;
  };

  // Pass 1: every non-context feature.
  for (let c = 0; c < dim; c++) {
    const { def, spec } = feats[c] as (typeof feats)[number];
    if (!spec.raw) continue;
    for (let r = 0; r < unitIds.length; r++) {
      const raw = spec.raw(ctx, unitIds[r] as number);
      const v = raw === null ? def.default : sanitize(applyTransform(def.transform, raw), def);
      x[r * dim + c] = Math.fround(v) + 0; // + 0 turns -0 into +0
    }
  }
  // Pass 2: context features copy the finished value of a source feature at another node's row.
  const colOf = new Map(feats.map((f, c) => [f.def.name, c] as const));
  for (let c = 0; c < dim; c++) {
    const { def } = feats[c] as (typeof feats)[number];
    if (!def.context) continue;
    const src = colOf.get(def.context.source);
    if (src === undefined) throw new VectorizeError(`context feature "${def.name}" needs source feature "${def.context.source}" in the schema`);
    for (let r = 0; r < unitIds.length; r++) {
      const i = unitIds[r] as number;
      const j = def.context.rel === "parent" ? (ctx.nodes[i] as { parent: number }).parent : def.context.rel === "prev" ? (ctx.prev[i] as number) : (ctx.next[i] as number);
      const jr = j >= 0 ? (rowOf[j] as number) : -1;
      x[r * dim + c] = jr >= 0 ? (x[jr * dim + src] as number) : Math.fround(def.default);
    }
  }
  return { dim, unit_ids: unitIds, x, n_nodes_total: ctx.n, prefiltered, sanitized: { nan_replaced: nanReplaced, clipped } };
}

/**
 * The contract document (`gran-prix.node-features`). `features_id` is the content id of the document
 * (same rule as the contracts' `contractId("node-features", doc)`), computed here with a pure SHA-256.
 */
export function vectorize(snapshot: SnapshotLike, schema: FeatureSchemaLike): NodeFeaturesDoc {
  const m = vectorizeMatrix(snapshot, schema);
  const rows: number[][] = [];
  for (let r = 0; r < m.unit_ids.length; r++) rows.push(Array.from(m.x.subarray(r * m.dim, (r + 1) * m.dim)));
  const body = {
    format: "gran-prix.node-features" as const,
    format_version: "1.0.0" as const,
    snapshot_id: snapshot.snapshot_id,
    feature_schema_id: schema.schema_id,
    extractor: { name: schema.extractor.name, version: schema.extractor.version },
    n_nodes_total: m.n_nodes_total,
    prefiltered: m.prefiltered,
    sanitized: m.sanitized,
    unit_ids: m.unit_ids,
    x: rows,
  };
  return { features_id: artifactId(body), ...body };
}
