import { inject, describe, expect, it } from "vitest";
import type { LabelSource, NodeLabelItem } from "@gran-prix/contracts";
import { validate } from "@gran-prix/contracts";
import {
  SOURCE_PRECEDENCE,
  buildNodeLabels,
  labelPageReadability,
  labelPageTruth,
  mergeLabels,
  type NodeLabelsDoc,
} from "../src/index.js";
import { loadCorpus } from "./helpers.js";

const SNAP = `sha256:${"a".repeat(64)}` as const;

const layer = (kind: LabelSource, items: NodeLabelItem[], snapshot = SNAP): NodeLabelsDoc =>
  buildNodeLabels({ snapshot_id: snapshot, labeler: { id: `${kind}@1`, kind, params: { kind } }, items, n_candidates: 4 });
const item = (unit_id: number, y: number, source: LabelSource, confidence = 0.8): NodeLabelItem => ({ unit_id, y, confidence, source });

describe("merge precedence", () => {
  it("is human > llm > heuristic, with each label keeping its own source", () => {
    expect(SOURCE_PRECEDENCE.indexOf("human")).toBeLessThan(SOURCE_PRECEDENCE.indexOf("llm"));
    expect(SOURCE_PRECEDENCE.indexOf("llm")).toBeLessThan(SOURCE_PRECEDENCE.indexOf("heuristic"));
    const heur = layer("heuristic", [item(1, 2, "heuristic"), item(2, 2, "heuristic"), item(3, 2, "heuristic"), item(4, 2, "heuristic")]);
    const llm = layer("llm", [item(2, 0, "llm", 0.9), item(3, 0, "llm", 0.9)]);
    const human = layer("human", [item(3, 1, "human", 1)]);
    const merged = mergeLabels([heur, llm, human]);
    expect(merged.items.map((i) => [i.unit_id, i.y, i.source])).toEqual([
      [1, 2, "heuristic"],
      [2, 0, "llm"],
      [3, 1, "human"],
      [4, 2, "heuristic"],
    ]);
  });

  it("does not depend on the order of the layers", () => {
    const a = layer("heuristic", [item(1, 2, "heuristic")]);
    const b = layer("human", [item(1, 0, "human", 0.6)]); // a LESS confident human still beats a heuristic
    const c = layer("llm", [item(1, 1, "llm", 0.99)]);
    const one = mergeLabels([a, b, c]);
    const two = mergeLabels([c, b, a]);
    expect(one.items).toEqual(two.items);
    expect(one.items[0]).toMatchObject({ y: 0, source: "human" });
    expect(one.labels_id).not.toBe(two.labels_id); // inputs are recorded in layer order
  });

  it("breaks ties inside a source by confidence, then by the earlier layer", () => {
    const a = layer("llm", [item(1, 0, "llm", 0.7)]);
    const b = layer("llm", [item(1, 2, "llm", 0.9)]);
    expect(mergeLabels([a, b]).items[0]).toMatchObject({ y: 2 });
    const c = layer("llm", [item(1, 1, "llm", 0.7)]);
    expect(mergeLabels([a, c]).items[0]).toMatchObject({ y: 0 });
  });

  it("records the layers, is a valid merge document, and refuses mixed snapshots or label spaces", () => {
    const a = layer("heuristic", [item(1, 2, "heuristic")]);
    const b = layer("human", [item(2, 0, "human", 1)]);
    const m = mergeLabels([a, b]);
    expect(m.labeler).toMatchObject({ kind: "merge", inputs: [a.labels_id, b.labels_id] });
    expect(m.coverage).toEqual({ n_labeled: 2, n_candidates: 4 });
    expect(validate("node-labels", m).issues).toEqual([]);
    expect(() => mergeLabels([a, layer("human", [], `sha256:${"b".repeat(64)}`)])).toThrow(/different snapshots/);
    const binary = { ...b, label_space: { kind: "binary", classes: ["drop", "keep"] } } as unknown as NodeLabelsDoc;
    expect(() => mergeLabels([a, binary])).toThrow(/label spaces/);
    expect(() => mergeLabels([])).toThrow(/at least one/);
  });

  it("merges real labels: human truth over Readability on a fixture page", () => {
    const p = loadCorpus(inject("corpusDir"), ["article-1"])[0]!;
    const heur = labelPageReadability(p);
    const human = labelPageTruth(p, p.truth.rules);
    const merged = mergeLabels([heur, human]);
    expect(validate("node-labels", merged).issues).toEqual([]);
    expect(merged.items.every((i) => i.source === "human")).toBe(true);
    expect(merged.items.length).toBe(human.items.length);
  });
});
