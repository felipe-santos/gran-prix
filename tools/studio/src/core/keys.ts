import type { Action } from "./reducer.js";
import type { LabelClass } from "./types.js";

/** The slice of a KeyboardEvent the keymap reads (a plain object in unit tests). */
export interface KeyInput {
  key: string;
  code?: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/** Actions that are not label edits: handled by the page view (panel toggles, export, confirmation prompts). */
export type UiAction = { type: "ui"; what: "help" | "guide" | "export" | "toggle-disagreements" | "toggle-autoadvance" };

export const KEYMAP_DOC: ReadonlyArray<{ keys: string; does: string }> = [
  { keys: "1 / 2 / 3", does: "label the selected element AND its subtree: main / support / noise" },
  { keys: "Shift+1 / 2 / 3", does: "label only the selected element (children keep what they had)" },
  { keys: "d / m", does: "toggle the doubt / mixed flag (right after a label key: on the node you just labeled)" },
  { keys: "j / k", does: "next / previous UNLABELED unit" },
  { keys: "Down / Up", does: "next / previous unit, labeled or not" },
  { keys: "Left (h) / Right (l)", does: "select the parent (grow) / go back down the path" },
  { keys: "c or Enter", does: "review mode: accept the draft label of the selected node" },
  { keys: "Shift+C", does: "review mode: accept the draft for every unit still unlabeled (asks first)" },
  { keys: "x / Backspace", does: "clear the labels of the selected subtree" },
  { keys: "u / Ctrl+Z, Shift+U / Ctrl+Y", does: "undo / redo" },
  { keys: "e", does: "export this page (refused while any unit of U is unlabeled)" },
  { keys: "v", does: "review mode: show only disagreements with the draft" },
  { keys: "a", does: "toggle auto-advance after a label key" },
  { keys: "g / ?", does: "guide quick reference / this key map" },
];

const DIGIT_CLASS: Record<string, LabelClass> = { "1": "main", "2": "support", "3": "noise" };

/** Digit of a key press, layout-proof: Shift+1 reports key "!" on US layouts, so read `code` first. */
function digitOf(e: KeyInput): string | null {
  const m = /^(?:Digit|Numpad)([1-3])$/.exec(e.code ?? "");
  if (m) return m[1] as string;
  return e.key in DIGIT_CLASS ? e.key : null;
}

/** Maps a key press to an action; null when the key means nothing here (the browser keeps it). */
export function keyToAction(e: KeyInput): Action | UiAction | null {
  const ctrl = e.ctrlKey === true || e.metaKey === true;
  if (e.altKey === true) return null;
  const key = e.key;
  if (ctrl) {
    const k = key.toLowerCase();
    if (k === "z") return { type: e.shiftKey === true ? "redo" : "undo" };
    if (k === "y") return { type: "redo" };
    return null;
  }
  const digit = digitOf(e);
  if (digit !== null) return { type: "label", cls: DIGIT_CLASS[digit] as LabelClass, scope: e.shiftKey === true ? "element" : "subtree" };
  switch (key) {
    case "d":
      return { type: "flag", flag: "doubt" };
    case "m":
      return { type: "flag", flag: "mixed" };
    case "j":
      return { type: "nav", to: "next-unlabeled" };
    case "k":
      return { type: "nav", to: "prev-unlabeled" };
    case "ArrowDown":
      return { type: "nav", to: "next-unit" };
    case "ArrowUp":
      return { type: "nav", to: "prev-unit" };
    case "ArrowLeft":
    case "h":
      return { type: "nav", to: "parent" };
    case "ArrowRight":
    case "l":
      return { type: "nav", to: "child" };
    case "c":
    case "Enter":
      return { type: "accept-draft" };
    case "C":
      return { type: "accept-all-drafts" };
    case "x":
    case "Backspace":
    case "Delete":
      return { type: "clear" };
    case "u":
      return { type: "undo" };
    case "U":
      return { type: "redo" };
    case "e":
      return { type: "ui", what: "export" };
    case "v":
      return { type: "ui", what: "toggle-disagreements" };
    case "a":
      return { type: "ui", what: "toggle-autoadvance" };
    case "g":
      return { type: "ui", what: "guide" };
    case "?":
      return { type: "ui", what: "help" };
    default:
      return null;
  }
}
