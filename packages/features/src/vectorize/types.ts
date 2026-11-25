// Structural types for the pure vectorizer. They deliberately do NOT import @gran-prix/contracts:
// this folder is compiled with no DOM and no Node types (tsconfig.pure.json) and is bundled into the
// in-page IIFE. The tests assert that these shapes are assignable to / from the contract types.

export type Sha256Like = `sha256:${string}`;
export type SemVerLike = `${number}.${number}.${number}`;

export interface SnapNodeLike {
  idx: number;
  parent: number;
  depth: number;
  tag: string;
  attrs: { id?: string; class?: string; role?: string; [k: string]: string | undefined };
  own_text: string;
  own_text_len: number;
  text_len: number;
  link_text_len: number;
  child_elems: number;
  style: {
    display: string;
    visibility: string;
    opacity: number;
    position: string;
    font_size: number;
    font_weight: number;
    float?: string;
    z_index?: number;
  };
  rect: { x: number; y: number; w: number; h: number } | null;
  flags: { in_shadow: boolean; iframe_depth: number };
}

export interface SnapshotLike {
  snapshot_id: Sha256Like;
  /** `og_type` and `jsonld_types` are extensions of the contract's `page` object (open schema). */
  page: { og_type?: string; jsonld_types?: string[]; [k: string]: unknown };
  doc: { viewport_w: number; viewport_h: number; scroll_w: number; scroll_h: number };
  nodes: SnapNodeLike[];
}

export type StaticTransformLike =
  | { op: "none" }
  | { op: "log1p"; scale: number }
  | { op: "clip"; lo: number; hi: number }
  | { op: "div"; by: number };

export type FeatureKind = "scalar" | "bool" | "onehot" | "hash_bucket";

export type ContextRel = "parent" | "prev" | "next";

export interface FeatureDefLike {
  index: number;
  name: string;
  kind: FeatureKind;
  group?: string;
  doc: string;
  transform: StaticTransformLike;
  range: [number, number];
  default: number;
  since: SemVerLike;
  onehot?: { of: string; value: string };
  hash?: { fn: "fnv1a32"; buckets: number };
  /** Extension: this feature is the value of another feature of the parent / previous / next sibling node. */
  context?: { rel: ContextRel; source: string };
}

export type PrefilterRuleLike =
  | { id: string; kind: "tag"; tags: string[] }
  | { id: string; kind: "style"; display_none: true }
  | { id: string; kind: "visibility_hidden" | "zero_rect" };

export interface FeatureSchemaLike {
  schema_id: Sha256Like;
  extractor: { name: string; version: SemVerLike };
  dim: number;
  features: FeatureDefLike[];
  prefilter: { rules_version: string; rules: PrefilterRuleLike[] };
  missing_policy: { nan: "zero"; inf: "clip" };
}

export interface NodeFeaturesDoc {
  format: "gran-prix.node-features";
  format_version: "1.0.0";
  features_id: Sha256Like;
  snapshot_id: Sha256Like;
  feature_schema_id: Sha256Like;
  extractor: { name: string; version: SemVerLike };
  n_nodes_total: number;
  prefiltered: Record<string, number>;
  sanitized: { nan_replaced: number; clipped: number };
  unit_ids: number[];
  x: number[][];
}

/** The numeric core of `vectorize`: what the training and inference paths consume. */
export interface FeatureMatrix {
  dim: number;
  /** Snapshot node idx of each row, strictly increasing. */
  unit_ids: number[];
  /** Row-major float32, `unit_ids.length * dim` values. */
  x: Float32Array;
  n_nodes_total: number;
  prefiltered: Record<string, number>;
  sanitized: { nan_replaced: number; clipped: number };
}

export class VectorizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorizeError";
  }
}
