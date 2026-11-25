import { effectiveLabels } from "./labels.js";
import type { PageModel } from "./model.js";
import { classIndex, type LabelState } from "./types.js";

/** One exported label: the contract's `NodeLabelItem` minus the constant fields (confidence, source). */
export interface ExportItem {
  unit_id: number;
  y: number;
  /** `doubt`, `mixed` or `doubt,mixed`; absent when the unit has no flag (guide 2.4: flags travel in `reason`). */
  reason?: string;
}

export type ExportPlan = { ok: true; items: ExportItem[] } | { ok: false; unlabeled: number[] };

/**
 * The export rule: every unit of U must have an effective label. When one is missing nothing is exported and the
 * missing units are listed (document order). Containers outside U are never exported; they only feed inheritance.
 */
export function planExport(m: PageModel, s: LabelState): ExportPlan {
  const eff = effectiveLabels(m, s);
  const unlabeled: number[] = [];
  const items: ExportItem[] = [];
  for (const u of m.units) {
    const c = eff.cls[u];
    if (c === null || c === undefined) {
      unlabeled.push(u);
      continue;
    }
    const flags = s.flags[u] ?? [];
    items.push({ unit_id: u, y: classIndex(c), ...(flags.length > 0 ? { reason: [...flags].sort().join(",") } : {}) });
  }
  return unlabeled.length > 0 ? { ok: false, unlabeled } : { ok: true, items };
}
