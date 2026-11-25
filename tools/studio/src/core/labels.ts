import type { PageModel } from "./model.js";
import { containsNode } from "./model.js";
import { isFlag, isLabelClass, type Flag, type LabelClass, type LabelState } from "./types.js";

/**
 * Label semantics of the guide (section 2.2): the label of an element is the one of the nearest
 * ancestor-or-self that has an EXPLICIT label; an explicit label on a descendant wins. Labeling a container
 * applies to its subtree (and erases the explicit labels below it); the exceptions are corrected afterwards.
 */

/** Effective label per node (null = unlabeled) and the idx that supplies it. */
export interface Effective {
  cls: (LabelClass | null)[];
  from: Int32Array;
}

export function effectiveLabels(m: PageModel, s: LabelState): Effective {
  const cls: (LabelClass | null)[] = new Array<LabelClass | null>(m.n).fill(null);
  const from = new Int32Array(m.n).fill(-1);
  for (let i = 0; i < m.n; i++) {
    const own = s.explicit[i];
    if (own !== undefined) {
      cls[i] = own;
      from[i] = i;
    } else {
      const p = m.parent[i] as number;
      if (p >= 0) {
        cls[i] = cls[p] ?? null;
        from[i] = from[p] as number;
      }
    }
  }
  return { cls, from };
}

export type Scope = "subtree" | "element";

/**
 * Sets a label. `subtree`: explicit on `idx`, and every explicit label (class and flags are kept) below it is
 * dropped so the whole subtree follows. `element`: only `idx` changes: its direct children that were relying on
 * inheritance get the label they had pinned, so they do not follow the new value.
 */
export function applyLabel(m: PageModel, s: LabelState, idx: number, cls: LabelClass, scope: Scope): LabelState {
  const explicit = { ...s.explicit };
  if (scope === "subtree") {
    const end = idx + (m.size[idx] as number);
    for (let i = idx + 1; i < end; i++) delete explicit[i];
  } else {
    const before = effectiveLabels(m, s);
    const end = idx + (m.size[idx] as number);
    for (let c = idx + 1; c < end; c += m.size[c] as number) {
      const prev = before.cls[c] ?? null;
      if (explicit[c] === undefined && prev !== null) explicit[c] = prev;
    }
  }
  explicit[idx] = cls;
  return { explicit, flags: s.flags };
}

/** Removes the explicit labels (and flags) of a whole subtree: the nodes fall back to an ancestor or to unlabeled. */
export function clearSubtree(m: PageModel, s: LabelState, idx: number): LabelState {
  const explicit = { ...s.explicit };
  const flags = { ...s.flags };
  const end = idx + (m.size[idx] as number);
  for (let i = idx; i < end; i++) {
    delete explicit[i];
    delete flags[i];
  }
  return { explicit, flags };
}

/** The elements a flag key acts on: the element itself when it is a unit, else every unit of its subtree. */
export function flagTargets(m: PageModel, idx: number): number[] {
  if ((m.inU[idx] as number) !== 0) return [idx];
  const out: number[] = [];
  const end = idx + (m.size[idx] as number);
  for (let i = idx; i < end; i++) if ((m.inU[i] as number) !== 0) out.push(i);
  return out;
}

/** Toggles a flag on the targets: when every target has it, it is removed from all, otherwise added to all. */
export function toggleFlag(s: LabelState, targets: readonly number[], flag: Flag): LabelState {
  if (targets.length === 0) return s;
  const all = targets.every((t) => (s.flags[t] ?? []).includes(flag));
  const flags = { ...s.flags };
  for (const t of targets) {
    const cur = (flags[t] ?? []).filter((f) => f !== flag);
    const next = all ? cur : [...cur, flag];
    if (next.length === 0) delete flags[t];
    else flags[t] = next.sort();
  }
  return { explicit: s.explicit, flags };
}

/** Units of U whose effective label is missing, in document order. */
export function unlabeledUnits(m: PageModel, eff: Effective): number[] {
  return m.units.filter((u) => eff.cls[u] === null || eff.cls[u] === undefined);
}

export interface Progress {
  total: number;
  labeled: number;
  doubt: number;
  mixed: number;
}

export function progressOf(m: PageModel, s: LabelState, eff: Effective): Progress {
  let labeled = 0;
  let doubt = 0;
  let mixed = 0;
  for (const u of m.units) {
    if (eff.cls[u] !== null && eff.cls[u] !== undefined) labeled++;
    const f = s.flags[u] ?? [];
    if (f.includes("doubt")) doubt++;
    if (f.includes("mixed")) mixed++;
  }
  return { total: m.units.length, labeled, doubt, mixed };
}

/** A draft (LLM or heuristic labels): class per node idx. */
export type Draft = Readonly<Record<string, LabelClass>>;

/** Units whose human label differs from the draft (only units that have both). */
export function disagreements(m: PageModel, eff: Effective, draft: Draft | null): number[] {
  if (draft === null) return [];
  return m.units.filter((u) => {
    const h = eff.cls[u];
    const d = draft[u];
    return h !== null && h !== undefined && d !== undefined && h !== d;
  });
}

/**
 * Review mode, "confirm the draft": gives every unit below `idx` that has a draft its draft class as an explicit
 * label (the element itself when it is a unit). Units without a draft are left alone. With `onlyUnlabeled`, units that
 * already have a human label keep it (used by "accept everything that is left").
 */
export function acceptDraft(m: PageModel, s: LabelState, draft: Draft, idx: number, onlyUnlabeled = false): LabelState {
  const eff = effectiveLabels(m, s);
  const explicit = { ...s.explicit };
  const targets = flagTargets(m, idx);
  for (const u of targets) {
    const d = draft[u];
    if (d === undefined) continue;
    if (onlyUnlabeled && eff.cls[u] !== null && eff.cls[u] !== undefined) continue;
    explicit[u] = d;
  }
  return { explicit, flags: s.flags };
}

/** Defensive parse of a stored/received state: drops unknown classes, flags and out-of-range ids. */
export function sanitizeState(raw: unknown, n: number): LabelState {
  const out: LabelState = { explicit: {}, flags: {} };
  if (raw === null || typeof raw !== "object") return out;
  const r = raw as { explicit?: unknown; flags?: unknown };
  const okIdx = (k: string): boolean => /^(0|[1-9][0-9]*)$/.test(k) && Number(k) < n;
  if (r.explicit && typeof r.explicit === "object") {
    for (const [k, v] of Object.entries(r.explicit)) if (okIdx(k) && isLabelClass(v)) out.explicit[k] = v;
  }
  if (r.flags && typeof r.flags === "object") {
    for (const [k, v] of Object.entries(r.flags)) {
      if (!okIdx(k) || !Array.isArray(v)) continue;
      const f = [...new Set(v.filter(isFlag))].sort();
      if (f.length > 0) out.flags[k] = f;
    }
  }
  return out;
}

/** Size of the subtree below idx that is covered by a label supplied from `idx` or an ancestor (for the info panel). */
export function labeledBelow(m: PageModel, eff: Effective, idx: number): { units: number; labeled: number } {
  let units = 0;
  let labeled = 0;
  for (const u of m.units) {
    if (!containsNode(m, idx, u)) continue;
    units++;
    if (eff.cls[u] !== null && eff.cls[u] !== undefined) labeled++;
  }
  return { units, labeled };
}
