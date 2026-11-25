import type { Sha256 } from "@gran-prix/contracts";
import type { ArtifactStore } from "./store.js";

export interface LineageNode {
  id: Sha256;
  type: string;
  /** Absent for external inputs (no producing stage). */
  producedBy?: { stage_id: string; impl: string; run_id: string; cache_key: Sha256 };
  /** Port each input was read from, with that input's own lineage. */
  inputs: Array<{ port: string; node: LineageNode }>;
}

/**
 * Walks the provenance sidecars (`meta.json`) from an artifact up to the
 * external inputs. Provenance is that of the FIRST producer: an artifact with
 * identical content produced again by another stage keeps its first lineage.
 */
export function lineageOf(store: ArtifactStore, id: Sha256, seen: Set<Sha256> = new Set()): LineageNode {
  const meta = store.meta(id);
  const node: LineageNode = { id, type: meta.type, inputs: [] };
  const prov = meta.provenance;
  if (!prov) return node;
  node.producedBy = {
    stage_id: prov.produced_by.stage_id,
    impl: prov.produced_by.impl,
    run_id: prov.produced_by.run_id,
    cache_key: prov.produced_by.cache_key,
  };
  if (seen.has(id)) return node;
  const next = new Set(seen).add(id);
  for (const input of prov.inputs) {
    if (store.has(input.artifact_id)) node.inputs.push({ port: input.port, node: lineageOf(store, input.artifact_id, next) });
  }
  return node;
}
