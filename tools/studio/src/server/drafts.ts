import type { NodeFeatures, NodeLabels } from "@gran-prix/contracts";
import { LABEL_CLASSES, type LabelClass } from "../core/types.js";
import type { Draft } from "../core/labels.js";
import type { PageData } from "./pages.js";
import { readHtml, listLabelDocs } from "./snapshot-set.js";

/**
 * Drafts for REVIEW mode: labels somebody else (the LLM, a heuristic, a truth import) made. Never offered in
 * blind mode (the server refuses, see app.ts). Sources, in this order of preference:
 *  1. NodeLabels documents in NodeLabelsSet artifacts of the data dir (written by `gp run` label stages);
 *  2. otherwise Readability, computed here from the snapshot (kept -> main, dropped -> noise).
 * Documents of the Studio's own exports (`human@...`) are never drafts.
 */

export interface DraftInfo {
  labels_id: string;
  labeler_id: string;
  kind: string;
  /** Number of units the draft labels. */
  n: number;
}

export interface DraftSet extends DraftInfo {
  draft: Draft;
}

const KIND_RANK: Record<string, number> = { llm: 0, merge: 1, readability: 2, heuristic: 2, rule: 3, human: 4, user_feedback: 5 };

const threeClass = (l: NodeLabels): boolean => l.label_space.kind === "multiclass" && l.label_space.classes.join("|") === LABEL_CLASSES.join("|");

function toDraft(l: NodeLabels): DraftSet {
  const draft: Record<string, LabelClass> = {};
  for (const it of l.items) {
    const c = LABEL_CLASSES[it.y];
    if (c !== undefined) draft[it.unit_id] = c;
  }
  return { labels_id: l.labels_id, labeler_id: l.labeler.id, kind: l.labeler.kind, n: l.items.length, draft };
}

export class DraftStore {
  private stored: Map<string, NodeLabels[]> | null = null;
  private readonly computed = new Map<string, DraftSet | null>();

  constructor(private readonly dataDir: string) {}

  /** Re-read the store on the next call (new artifacts may have appeared). */
  refresh(): void {
    this.stored = null;
  }

  private docs(): Map<string, NodeLabels[]> {
    this.stored ??= listLabelDocs(this.dataDir);
    return this.stored;
  }

  /** Stored drafts of a snapshot, best source first. */
  storedFor(snapshotId: string): DraftSet[] {
    const docs = (this.docs().get(snapshotId) ?? []).filter((d) => threeClass(d) && !d.labeler.id.startsWith("human@") && d.items.length > 0);
    return docs.map(toDraft).sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || a.labels_id.localeCompare(b.labels_id));
  }

  /** All drafts available for a page: the stored ones, or a freshly computed Readability draft when there are none. */
  async forPage(page: PageData): Promise<DraftSet[]> {
    const stored = this.storedFor(page.snapshot.snapshot_id);
    if (stored.length > 0) return stored;
    const computed = await this.readability(page);
    return computed ? [computed] : [];
  }

  private async readability(page: PageData): Promise<DraftSet | null> {
    const id = page.snapshot.snapshot_id;
    if (this.computed.has(id)) return this.computed.get(id) ?? null;
    let out: DraftSet | null = null;
    try {
      const { labelPageReadability } = await import("@gran-prix/labels");
      const unit_ids = page.snapshot.nodes.filter((n) => n.own_text_len > 0).map((n) => n.idx);
      // labelPageReadability only reads `snapshot_id` and `unit_ids` of the features; the rest is not needed here.
      const features = { snapshot_id: id, unit_ids } as unknown as NodeFeatures;
      const doc = labelPageReadability({ snapshot: page.snapshot, features, html: readHtml(page.ref) });
      if (doc.items.length > 0) out = toDraft(doc);
    } catch {
      out = null; // jsdom or Readability unavailable: review mode then has no draft for the page
    }
    this.computed.set(id, out);
    return out;
  }
}
