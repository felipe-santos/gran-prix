import { describe, expect, it } from "vitest";
import { planExport } from "../src/core/export.js";
import { keyToAction, type UiAction } from "../src/core/keys.js";
import { effectiveLabels } from "../src/core/labels.js";
import { initialState, reduce, type Action, type ReduceContext, type StudioState } from "../src/core/reducer.js";
import { emptyLabelState } from "../src/core/types.js";
import { sampleModel } from "./helpers.js";

const model = sampleModel();
const ctx: ReduceContext = { model, draft: null };

/** Plays a sequence of key presses through the keymap and the reducer, the way the page view does. */
function play(keys: Array<string | { key: string; code?: string; shiftKey?: boolean; ctrlKey?: boolean }>, c: ReduceContext = ctx, from?: StudioState): StudioState {
  let s = from ?? initialState(emptyLabelState(), { model });
  for (const k of keys) {
    const ev = typeof k === "string" ? { key: k } : k;
    const a = keyToAction(ev);
    if (a === null || a.type === "ui") continue;
    s = reduce(c, s, a as Action);
  }
  return s;
}

describe("keymap", () => {
  it("maps 1/2/3 to the classes (subtree), Shift+digit to element-only, even when Shift changes `key`", () => {
    expect(keyToAction({ key: "1" })).toEqual({ type: "label", cls: "main", scope: "subtree" });
    expect(keyToAction({ key: "2" })).toEqual({ type: "label", cls: "support", scope: "subtree" });
    expect(keyToAction({ key: "3" })).toEqual({ type: "label", cls: "noise", scope: "subtree" });
    expect(keyToAction({ key: "#", code: "Digit3", shiftKey: true })).toEqual({ type: "label", cls: "noise", scope: "element" });
    expect(keyToAction({ key: "2", code: "Numpad2" })).toEqual({ type: "label", cls: "support", scope: "subtree" });
  });

  it("maps flags, navigation, undo/redo and ui keys; ignores Alt chords and unknown keys", () => {
    expect(keyToAction({ key: "d" })).toEqual({ type: "flag", flag: "doubt" });
    expect(keyToAction({ key: "m" })).toEqual({ type: "flag", flag: "mixed" });
    expect(keyToAction({ key: "j" })).toEqual({ type: "nav", to: "next-unlabeled" });
    expect(keyToAction({ key: "k" })).toEqual({ type: "nav", to: "prev-unlabeled" });
    expect(keyToAction({ key: "z", ctrlKey: true })).toEqual({ type: "undo" });
    expect(keyToAction({ key: "Z", ctrlKey: true, shiftKey: true })).toEqual({ type: "redo" });
    expect(keyToAction({ key: "u" })).toEqual({ type: "undo" });
    expect(keyToAction({ key: "e" })).toEqual<UiAction>({ type: "ui", what: "export" });
    expect(keyToAction({ key: "1", altKey: true })).toBeNull();
    expect(keyToAction({ key: "q" })).toBeNull();
    expect(keyToAction({ key: "c", ctrlKey: true })).toBeNull();
  });
});

describe("reducer", () => {
  it("starts on the first unit; j / k move over unlabeled units and wrap around", () => {
    let s = initialState(emptyLabelState(), { model });
    expect(s.selected).toBe(2);
    s = play(["j"], ctx, s);
    expect(s.selected).toBe(4);
    s = play(["k", "k"], ctx, s); // 2 then wraps to the last unit
    expect(s.selected).toBe(9);
  });

  it("a label key labels the selection's subtree and auto-advances to the next unlabeled unit", () => {
    const s = play(["1"]); // selected = nav (2)
    expect(s.labels.explicit).toEqual({ 2: "main" });
    expect(s.selected).toBe(4);
  });

  it("labeling a container covers all of it and jumps past the subtree", () => {
    let s = initialState(emptyLabelState(), { model, select: 3 }); // <main>
    s = play(["3"], ctx, s);
    expect(s.labels.explicit).toEqual({ 3: "noise" });
    expect(s.selected).toBe(9); // the cursor jumps past the subtree to the next unlabeled unit (the footer)
  });

  it("labeling every unit by keyboard completes U (the export rule) and then stays put", () => {
    const s = play(["1", "2"]);
    let t = initialState(emptyLabelState(), { model });
    for (let guard = 0; guard < 20 && !planExport(model, t.labels).ok; guard++) t = play(["2"], ctx, t);
    expect(planExport(model, t.labels).ok).toBe(true);
    expect(s.labels.explicit).toEqual({ 2: "main", 4: "support" });
  });

  it("flags pressed right after a label key apply to the node just labeled, not to the next one", () => {
    let s = play(["2", "d", "m"]);
    expect(s.labels.explicit).toEqual({ 2: "support" });
    expect(s.labels.flags).toEqual({ 2: ["doubt", "mixed"] });
    expect(s.selected).toBe(4); // the cursor already moved on
    s = play(["d"], ctx, play(["j"], ctx, s)); // after a navigation key the flag acts on the selection (6)
    expect(s.selected).toBe(6);
    expect(s.labels.flags[6]).toEqual(["doubt"]);
  });

  it("Shift+digit labels only the element; the grown selection (Left) then labels the container", () => {
    let s = initialState(emptyLabelState(), { model, select: 6 }); // first <p>
    s = play([{ key: "!", code: "Digit1", shiftKey: true }], { ...ctx, autoAdvance: false }, s);
    expect(s.labels.explicit).toEqual({ 6: "main" });
    s = play(["ArrowLeft", "3"], { ...ctx, autoAdvance: false }, s); // parent = div (5): subtree noise erases 6
    expect(s.selected).toBe(5);
    expect(s.labels.explicit).toEqual({ 5: "noise" });
    s = play(["ArrowRight"], ctx, s);
    expect(s.selected).toBe(6);
  });

  it("undo and redo walk the label history; clear removes a subtree's labels", () => {
    let s = play(["1", "2", "3"], { ...ctx, autoAdvance: true });
    expect(Object.keys(s.labels.explicit)).toHaveLength(3);
    s = play(["u", "u"], ctx, s);
    expect(Object.keys(s.labels.explicit)).toHaveLength(1);
    s = play([{ key: "Z", ctrlKey: true, shiftKey: true }], ctx, s);
    expect(Object.keys(s.labels.explicit)).toHaveLength(2);
    s = reduce(ctx, { ...s, selected: 3 }, { type: "clear" });
    expect(effectiveLabels(model, s.labels).cls[4]).toBeNull();
  });

  it("ArrowUp/ArrowDown visit units labeled or not; a new edit clears the redo stack", () => {
    let s = play(["1", "ArrowDown", "ArrowUp"]);
    expect(s.selected).toBe(4);
    s = play(["u", "2"], ctx, s);
    expect(s.future).toEqual([]);
  });
});

describe("review mode", () => {
  const draft = { 2: "noise", 4: "main", 6: "main", 7: "main", 8: "support", 9: "noise" } as const;
  const rctx: ReduceContext = { model, draft };

  it("c / Enter accept the draft of the selected unit and advance; the human can then override one node", () => {
    let s = play(["c", "Enter"], rctx);
    expect(s.labels.explicit).toEqual({ 2: "noise", 4: "main" });
    expect(s.selected).toBe(6);
    s = play([{ key: "2" }], rctx, s); // relabel 6 differently from its draft (main)
    expect(s.labels.explicit[6]).toBe("support");
  });

  it("Shift+C accepts everything still unlabeled and keeps the human's own labels", () => {
    let s = initialState(emptyLabelState(), { model, select: 6 });
    s = play(["2"], { ...rctx, autoAdvance: false }, s);
    s = play(["C"], rctx, s);
    expect(s.labels.explicit[6]).toBe("support");
    expect(planExport(model, s.labels).ok).toBe(true);
  });

  it("is a no-op in blind mode: there is no draft to accept", () => {
    const s = play(["c", "C"], ctx);
    expect(s.labels.explicit).toEqual({});
  });
});
