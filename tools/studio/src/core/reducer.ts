import { acceptDraft, applyLabel, clearSubtree, effectiveLabels, flagTargets, toggleFlag, type Draft, type Scope } from "./labels.js";
import type { PageModel } from "./model.js";
import type { Flag, LabelClass, LabelState } from "./types.js";

/**
 * The keyboard-first state machine of the page view. Pure: `reduce(ctx, state, action)` returns a new state and
 * never touches the DOM, so the whole labeling flow is unit-tested without a browser.
 */

export interface StudioState {
  labels: LabelState;
  /** Selected element (any node of the tree, units or containers); null before the first selection. */
  selected: number | null;
  /** Descendants the user grew the selection from (Left = parent, Right = back down the same path). */
  path: number[];
  /** Node whose label was just set by a key that auto-advanced: a following flag key applies to it. */
  justLabeled: number | null;
  past: LabelState[];
  future: LabelState[];
}

export interface ReduceContext {
  model: PageModel;
  /** Review mode: the draft; null in blind mode (draft actions are then no-ops). */
  draft: Draft | null;
  /** After a class key, jump to the next unlabeled unit (default true). */
  autoAdvance?: boolean;
}

export type NavTarget = "next-unlabeled" | "prev-unlabeled" | "next-unit" | "prev-unit" | "parent" | "child" | "first-unlabeled";

export type Action =
  | { type: "select"; idx: number }
  | { type: "label"; cls: LabelClass; scope: Scope }
  | { type: "clear" }
  | { type: "flag"; flag: Flag }
  | { type: "nav"; to: NavTarget }
  | { type: "accept-draft" }
  | { type: "accept-all-drafts" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "load"; labels: LabelState };

const HISTORY_LIMIT = 200;

export function initialState(labels: LabelState, start: { model: PageModel; select?: number | null }): StudioState {
  const first = start.select !== undefined ? start.select : (start.model.units[0] ?? null);
  return { labels, selected: first, path: [], justLabeled: null, past: [], future: [] };
}

function commit(s: StudioState, labels: LabelState, patch: Partial<StudioState> = {}): StudioState {
  if (labels === s.labels) return { ...s, ...patch };
  return { ...s, ...patch, labels, past: [...s.past, s.labels].slice(-HISTORY_LIMIT), future: [] };
}

/** Next/previous unit after `from` in document order that satisfies `want`, wrapping around; null when none does. */
function seek(m: PageModel, from: number | null, dir: 1 | -1, want: (unit: number) => boolean): number | null {
  const units = m.units;
  if (units.length === 0) return null;
  // Position of `from` among units: for a non-unit start use the first unit at/after it (forward) or before it (backward).
  let pos: number;
  if (from === null) pos = dir === 1 ? -1 : units.length;
  else if ((m.unitPos[from] as number) >= 0) pos = m.unitPos[from] as number;
  else {
    let lo = 0;
    while (lo < units.length && (units[lo] as number) < from) lo++;
    pos = dir === 1 ? lo - 1 : lo;
  }
  for (let step = 1; step <= units.length; step++) {
    const p = (((pos + dir * step) % units.length) + units.length) % units.length;
    const u = units[p] as number;
    if (want(u) && u !== from) return u;
  }
  return null;
}

export function reduce(ctx: ReduceContext, s: StudioState, a: Action): StudioState {
  const m = ctx.model;
  const advance = ctx.autoAdvance ?? true;
  const unlabeled = (labels: LabelState) => {
    const eff = effectiveLabels(m, labels);
    return (u: number): boolean => eff.cls[u] === null || eff.cls[u] === undefined;
  };
  switch (a.type) {
    case "select":
      if (a.idx < 0 || a.idx >= m.n) return s;
      return { ...s, selected: a.idx, path: [], justLabeled: null };

    case "label": {
      if (s.selected === null) return s;
      const labels = applyLabel(m, s.labels, s.selected, a.cls, a.scope);
      const next = advance ? seek(m, s.selected + (a.scope === "subtree" ? (m.size[s.selected] as number) - 1 : 0), 1, unlabeled(labels)) : null;
      if (next === null) return commit(s, labels, { justLabeled: null });
      return commit(s, labels, { selected: next, path: [], justLabeled: s.selected });
    }

    case "clear":
      if (s.selected === null) return s;
      return commit(s, clearSubtree(m, s.labels, s.selected), { justLabeled: null });

    case "flag": {
      const target = s.justLabeled ?? s.selected;
      if (target === null) return s;
      return commit(s, toggleFlag(s.labels, flagTargets(m, target), a.flag));
    }

    case "accept-draft": {
      if (s.selected === null || ctx.draft === null) return s;
      const labels = acceptDraft(m, s.labels, ctx.draft, s.selected);
      const from = s.selected + (m.inU[s.selected] === 0 ? (m.size[s.selected] as number) - 1 : 0);
      const next = advance ? seek(m, from, 1, unlabeled(labels)) : null;
      return commit(s, labels, next === null ? { justLabeled: null } : { selected: next, path: [], justLabeled: s.selected });
    }

    case "accept-all-drafts": {
      if (ctx.draft === null) return s;
      const labels = acceptDraft(m, s.labels, ctx.draft, 0, true);
      return commit(s, labels, { justLabeled: null });
    }

    case "nav": {
      const base = { justLabeled: null };
      const sel = s.selected;
      switch (a.to) {
        case "parent": {
          if (sel === null) return s;
          const p = m.parent[sel] as number;
          return p < 0 ? s : { ...s, ...base, selected: p, path: [...s.path, sel] };
        }
        case "child": {
          const c = s.path[s.path.length - 1];
          return c === undefined ? s : { ...s, ...base, selected: c, path: s.path.slice(0, -1) };
        }
        case "next-unit":
        case "prev-unit": {
          const u = seek(m, sel, a.to === "next-unit" ? 1 : -1, () => true);
          return u === null ? s : { ...s, ...base, selected: u, path: [] };
        }
        case "next-unlabeled":
        case "prev-unlabeled": {
          const u = seek(m, sel, a.to === "next-unlabeled" ? 1 : -1, unlabeled(s.labels));
          return u === null ? { ...s, ...base } : { ...s, ...base, selected: u, path: [] };
        }
        case "first-unlabeled": {
          const u = seek(m, null, 1, unlabeled(s.labels));
          return u === null ? s : { ...s, ...base, selected: u, path: [] };
        }
      }
      return s;
    }

    case "undo": {
      const prev = s.past[s.past.length - 1];
      if (prev === undefined) return s;
      return { ...s, labels: prev, past: s.past.slice(0, -1), future: [s.labels, ...s.future], justLabeled: null };
    }

    case "redo": {
      const nxt = s.future[0];
      if (nxt === undefined) return s;
      return { ...s, labels: nxt, past: [...s.past, s.labels], future: s.future.slice(1), justLabeled: null };
    }

    case "load":
      return { ...s, labels: a.labels, past: [], future: [], justLabeled: null };
  }
}
