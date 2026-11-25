import { describe, expect, it } from "vitest";
import { planExport } from "../src/core/export.js";
import {
  acceptDraft,
  applyLabel,
  clearSubtree,
  disagreements,
  effectiveLabels,
  progressOf,
  sanitizeState,
  toggleFlag,
  unlabeledUnits,
} from "../src/core/labels.js";
import { emptyLabelState } from "../src/core/types.js";
import { sampleModel } from "./helpers.js";

const m = sampleModel();

describe("subtree application: nearest-ancestor convention (guide 2.2)", () => {
  it("a label on a container is inherited by every node below it", () => {
    const s = applyLabel(m, emptyLabelState(), 3, "main", "subtree"); // <main>
    const eff = effectiveLabels(m, s);
    expect([4, 5, 6, 7, 8].map((i) => eff.cls[i])).toEqual(["main", "main", "main", "main", "main"]);
    expect(eff.from[7]).toBe(3);
    expect(eff.cls[2]).toBeNull();
    expect(eff.cls[9]).toBeNull();
  });

  it("an explicit label on a descendant wins over the ancestor's; labeling the subtree again erases the exceptions", () => {
    let s = applyLabel(m, emptyLabelState(), 3, "main", "subtree");
    s = applyLabel(m, s, 7, "noise", "subtree"); // the <a>
    expect(effectiveLabels(m, s).cls[7]).toBe("noise");
    expect(effectiveLabels(m, s).cls[6]).toBe("main");
    s = applyLabel(m, s, 3, "support", "subtree");
    expect(s.explicit).toEqual({ 3: "support" });
    expect(effectiveLabels(m, s).cls[7]).toBe("support");
  });

  it("'element only' changes one node: children that inherited keep their previous label", () => {
    let s = applyLabel(m, emptyLabelState(), 6, "main", "subtree"); // <p> and its <a> are main
    s = applyLabel(m, s, 6, "noise", "element");
    const eff = effectiveLabels(m, s);
    expect(eff.cls[6]).toBe("noise");
    expect(eff.cls[7]).toBe("main"); // pinned
  });

  it("'element only' on an unlabeled container pins nothing: children stay unlabeled", () => {
    const s = applyLabel(m, emptyLabelState(), 6, "support", "element");
    const eff = effectiveLabels(m, s);
    expect(eff.cls[6]).toBe("support");
    expect(eff.cls[7]).toBe("support"); // the child was unlabeled, so it still inherits the element's new label
  });

  it("clearSubtree drops labels and flags of the whole subtree", () => {
    let s = applyLabel(m, emptyLabelState(), 3, "main", "subtree");
    s = toggleFlag(s, [6], "doubt");
    s = clearSubtree(m, s, 5);
    expect(s.flags).toEqual({});
    expect(effectiveLabels(m, s).cls[3]).toBe("main");
    expect(effectiveLabels(m, s).cls[6]).toBe("main"); // inherits from <main> again
  });
});

describe("flags", () => {
  it("toggles on one unit, on all units of a container (all-or-none), and keeps them sorted and unique", () => {
    let s = toggleFlag(emptyLabelState(), [6], "mixed");
    s = toggleFlag(s, [6], "doubt");
    expect(s.flags[6]).toEqual(["doubt", "mixed"]);
    s = toggleFlag(s, [6], "doubt");
    expect(s.flags[6]).toEqual(["mixed"]);
    s = toggleFlag(s, [6, 8], "mixed"); // 6 has it, 8 does not: add to all
    expect(s.flags[8]).toEqual(["mixed"]);
    s = toggleFlag(s, [6, 8], "mixed"); // both have it: remove from all
    expect(s.flags).toEqual({});
  });
});

describe("U computation feeds progress and the unlabeled list", () => {
  it("units are the nodes with u>0 only; labeled counts follow inheritance", () => {
    expect(m.units).toEqual([2, 4, 6, 7, 8, 9]);
    let s = applyLabel(m, emptyLabelState(), 5, "main", "subtree");
    const eff = effectiveLabels(m, s);
    expect(unlabeledUnits(m, eff)).toEqual([2, 4, 9]);
    s = toggleFlag(s, [6], "doubt");
    expect(progressOf(m, s, eff)).toEqual({ total: 6, labeled: 3, doubt: 1, mixed: 0 });
  });
});

describe("export plan", () => {
  it("refuses while a unit of U is unlabeled and lists exactly the missing units", () => {
    const s = applyLabel(m, emptyLabelState(), 3, "main", "subtree");
    expect(planExport(m, s)).toEqual({ ok: false, unlabeled: [2, 9] });
  });

  it("exports every unit of U with the class index and the flags in `reason`, never the containers", () => {
    let s = applyLabel(m, emptyLabelState(), 0, "noise", "subtree");
    s = applyLabel(m, s, 3, "main", "subtree");
    s = applyLabel(m, s, 4, "support", "subtree");
    s = toggleFlag(s, [6], "mixed");
    s = toggleFlag(s, [6], "doubt");
    const plan = planExport(m, s);
    expect(plan).toEqual({
      ok: true,
      items: [
        { unit_id: 2, y: 2 },
        { unit_id: 4, y: 1 },
        { unit_id: 6, y: 0, reason: "doubt,mixed" },
        { unit_id: 7, y: 0 },
        { unit_id: 8, y: 0 },
        { unit_id: 9, y: 2 },
      ],
    });
  });
});

describe("review mode: draft, disagreements, accept", () => {
  const draft = { 2: "noise", 4: "main", 6: "main", 7: "main", 8: "main", 9: "noise" } as const;

  it("accepting the draft of a container labels each of its units with its own draft class", () => {
    const s = acceptDraft(m, emptyLabelState(), draft, 0);
    expect(planExport(m, s).ok).toBe(true);
    expect(disagreements(m, effectiveLabels(m, s), draft)).toEqual([]);
  });

  it("onlyUnlabeled keeps the human label; disagreements list the units where the human differs", () => {
    let s = applyLabel(m, emptyLabelState(), 6, "support", "element");
    s = acceptDraft(m, s, draft, 0, true);
    const eff = effectiveLabels(m, s);
    expect(eff.cls[6]).toBe("support");
    expect(disagreements(m, eff, draft)).toEqual([6, 7]); // the unlabeled <a> inherits `support` from its element
    expect(disagreements(m, eff, null)).toEqual([]);
  });
});

describe("sanitizeState", () => {
  it("drops unknown classes and flags, malformed ids and ids outside the tree", () => {
    const s = sanitizeState(
      { explicit: { "3": "main", "4": "bogus", "99": "noise", "x": "main", "01": "main" }, flags: { "6": ["doubt", "nope", "doubt"], "88": ["mixed"] } },
      12,
    );
    expect(s).toEqual({ explicit: { 3: "main" }, flags: { 6: ["doubt"] } });
    expect(sanitizeState(null, 3)).toEqual(emptyLabelState());
  });
});
