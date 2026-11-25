import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { FeatureSchema, NodeFeatures, PageSnapshot } from "@gran-prix/contracts";
import { fixtureNames, type FixtureTruth } from "../src/testing/index.js";
import type { TruthClass } from "../src/index.js";

export interface CorpusPage {
  name: string;
  snapshot: PageSnapshot;
  features: NodeFeatures;
  html: string;
  truth: FixtureTruth;
  /** Truth label per node idx evaluated in the live page. */
  browserTruth: Array<TruthClass | null>;
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

export function loadCorpus(dir: string, names: readonly string[] = fixtureNames()): CorpusPage[] {
  return names.map((name) => ({
    name,
    snapshot: readJson<PageSnapshot>(join(dir, "snapshots", name, "snapshot.json")),
    features: readJson<NodeFeatures>(join(dir, "features", `${name}.json`)),
    html: gunzipSync(readFileSync(join(dir, "snapshots", name, "page.html.gz"))).toString("utf8"),
    truth: readJson<FixtureTruth>(join(dir, "truth", `${name}.json`)),
    browserTruth: readJson<Array<TruthClass | null>>(join(dir, "browser-truth", `${name}.json`)),
  }));
}

export const loadSchema = (dir: string): FeatureSchema => readJson<FeatureSchema>(join(dir, "schema.json"));

export interface Prf {
  p: number;
  r: number;
  f1: number;
}

/** Char-weighted counts, summed over pages before the ratios are taken (micro-average), as in the spike. */
export class Counts {
  tp = 0;
  fp = 0;
  fn = 0;
  add(o: Counts): void {
    this.tp += o.tp;
    this.fp += o.fp;
    this.fn += o.fn;
  }
  prf(): Prf {
    const p = this.tp / (this.tp + this.fp);
    const r = this.tp / (this.tp + this.fn);
    return { p: 100 * p, r: 100 * r, f1: (100 * 2 * p * r) / (p + r) };
  }
}

/**
 * The spike's `pageCounts`: unit = element that owns text (`<title>` excluded) and has a truth label;
 * weight = characters of its own collapsed text; positive = truth in `positives`; predicted = `kept`.
 */
export function scorePage(
  ownText: ReadonlyMap<number, string>,
  tagOf: (idx: number) => string,
  truth: (idx: number) => TruthClass | null,
  kept: (idx: number) => boolean,
  positives: ReadonlySet<TruthClass>,
): Counts {
  const c = new Counts();
  for (const [idx, text] of ownText) {
    if (tagOf(idx) === "TITLE") continue;
    const label = truth(idx);
    if (label === null) continue;
    const w = text.length;
    const pos = positives.has(label);
    const k = kept(idx);
    if (pos && k) c.tp += w;
    else if (pos) c.fn += w;
    else if (k) c.fp += w;
  }
  return c;
}
