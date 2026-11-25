// Shared by the baseline-labeler tests: the 6-page corpus of the global setup loaded as pipeline externals,
// and a switch for the tests that need the Python sidecar (pylibs are gitignored, so a clean clone may lack them).
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { NodeLabels, PipelineSpec } from "@gran-prix/contracts";
import { ArtifactStore, dataPaths } from "../src/index.js";
import { trafilaturaVersion } from "../src/stages/baselines/trafilatura.js";

export function sidecarAvailable(): boolean {
  try {
    trafilaturaVersion();
    return true;
  } catch {
    return false;
  }
}

function tree(corpus: string, sub: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(corpus, sub, rel), { withFileTypes: true })) {
      const p = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else out[p] = new Uint8Array(readFileSync(join(corpus, sub, p)));
    }
  };
  walk("");
  return out;
}

/** Loads the corpus into the store of `dataDir` and returns the externals that pin it by id. */
export function corpusExternals(corpus: string, dataDir: string): NonNullable<PipelineSpec["externals"]> {
  mkdirSync(dataPaths(dataDir).artifacts, { recursive: true });
  const store = new ArtifactStore(dataPaths(dataDir).artifacts);
  const schema = JSON.parse(readFileSync(join(corpus, "schema.json"), "utf8")) as unknown;
  return {
    snapshots: { type: "SnapshotSet", id: store.putFiles("SnapshotSet", tree(corpus, "snapshot-set")) },
    features: { type: "NodeFeaturesSet", id: store.putFiles("NodeFeaturesSet", tree(corpus, "features-set")) },
    schema: { type: "FeatureSchema", id: store.putJson("FeatureSchema", schema) },
  };
}

export const SNAP = { snapshots: { external: "snapshots" }, features: { external: "features" } } as const;

/** NodeLabels documents of a produced `NodeLabelsSet`, by page name (`<name>` of the corpus index). */
export function labelDocs(dataDir: string, id: string, corpus: string): Map<string, NodeLabels & Record<string, unknown>> {
  const store = new ArtifactStore(dataPaths(dataDir).artifacts);
  const h = store.handle(id as `sha256:${string}`, "NodeLabelsSet");
  const index = JSON.parse(readFileSync(join(corpus, "index.json"), "utf8")) as Array<{ name: string; hex: string }>;
  const out = new Map<string, NodeLabels & Record<string, unknown>>();
  for (const f of h.files().filter((x) => x.endsWith(".json"))) {
    const doc = JSON.parse(Buffer.from(h.file(f)).toString("utf8")) as NodeLabels & Record<string, unknown>;
    const name = index.find((e) => doc.snapshot_id.endsWith(e.hex))?.name ?? f;
    out.set(name, doc);
  }
  return out;
}
