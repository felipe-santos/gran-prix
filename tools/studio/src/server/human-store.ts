import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { artifactId, canonicalJson, contractId, THREE_CLASS_SPACE, validate, type NodeLabels, type Sha256 } from "@gran-prix/contracts";
import { planExport } from "../core/export.js";
import { emptyLabelState, GUIDE_VERSION, isMode, LABEL_CLASSES, type LabelState, type Mode } from "../core/types.js";
import { sanitizeState } from "../core/labels.js";
import type { PageData } from "./pages.js";

/**
 * Files the Studio writes, all under `<data-dir>/human-labels/<annotator>/`:
 *   <snapshot hex>.json              working state of a page (explicit labels, flags, mode, draft used)
 *   timelog.jsonl                    append-only time log: one line per work session on a page
 *   export/labels/<hex12>.json       contract-valid NodeLabels (source=human), written by Export; the `labels/<hex12>.json`
 *                                    layout is the one of a NodeLabelsSet, so `export/` can be loaded as an external input
 */

export const STUDIO_VERSION = "1.0.0" as const;
export const STATE_FORMAT = "gran-prix.studio-labels";

export const ANNOTATOR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

export class StoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PageState extends LabelState {
  mode: Mode;
  /** Draft the review was done against (provenance of the "agreement with the draft" analysis). */
  draft: { labels_id: string; labeler_id: string } | null;
  updated_at: string | null;
}

export interface TimeEntry {
  page: string;
  mode: Mode;
  start: string;
  end: string;
  seconds: number;
  annotator: string;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}

export class HumanStore {
  readonly dir: string;

  constructor(
    dataDir: string,
    readonly annotator: string,
    private readonly defaultMode: Mode,
  ) {
    if (!ANNOTATOR_RE.test(annotator)) throw new Error(`invalid annotator name ${JSON.stringify(annotator)} (letters, digits, . _ - ; at most 48 characters)`);
    this.dir = join(dataDir, "human-labels", annotator);
  }

  statePath(hex: string): string {
    return join(this.dir, `${hex}.json`);
  }

  /** Saved state of a page, or an empty one in the default mode. */
  load(hex: string, nodeCount: number): PageState {
    const p = this.statePath(hex);
    if (!existsSync(p)) return { ...emptyLabelState(), mode: this.defaultMode, draft: null, updated_at: null };
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const s = sanitizeState(raw, nodeCount);
    const draft = raw["draft"] as PageState["draft"] | undefined;
    return {
      ...s,
      mode: isMode(raw["mode"]) ? raw["mode"] : this.defaultMode,
      draft: draft && typeof draft.labels_id === "string" ? { labels_id: draft.labels_id, labeler_id: String(draft.labeler_id ?? "") } : null,
      updated_at: typeof raw["updated_at"] === "string" ? raw["updated_at"] : null,
    };
  }

  /**
   * Saves the working state. The mode of a page cannot change once it holds a label: a blind page must not be
   * switched to review after the reviewer has seen a draft, and the other way round would mix the two protocols.
   */
  save(page: PageData, input: { labels: unknown; mode?: unknown; draft?: unknown; reset?: unknown }): PageState {
    const hex = page.ref.hex;
    const cur = this.load(hex, page.nodes.length);
    const mode = input.mode === undefined ? cur.mode : input.mode;
    if (!isMode(mode)) throw new StoreError(400, 'mode must be "blind" or "review"');
    const reset = input.reset === true;
    const labels = reset ? emptyLabelState() : sanitizeState(input.labels, page.nodes.length);
    const hadLabels = !reset && Object.keys(cur.explicit).length > 0;
    if (mode !== cur.mode && hadLabels) throw new StoreError(409, `page already has labels in ${cur.mode} mode: reset it before switching to ${mode}`);
    const d = input.draft as { labels_id?: unknown; labeler_id?: unknown } | null | undefined;
    const draft = mode === "review" && d && typeof d.labels_id === "string" ? { labels_id: d.labels_id, labeler_id: String(d.labeler_id ?? "") } : null;
    const next: PageState = { ...labels, mode, draft, updated_at: new Date().toISOString() };
    writeJsonAtomic(this.statePath(hex), {
      format: STATE_FORMAT,
      format_version: "1.0.0",
      snapshot_id: page.snapshot.snapshot_id,
      annotator: this.annotator,
      guide_version: GUIDE_VERSION,
      mode: next.mode,
      draft: next.draft,
      updated_at: next.updated_at,
      explicit: next.explicit,
      flags: next.flags,
    });
    return next;
  }

  /** Appends one work session to the time log. Validation is strict: this file feeds the human-hours budget. */
  logTime(hex: string, input: { mode?: unknown; start?: unknown; end?: unknown; seconds?: unknown }): TimeEntry {
    const iso = (v: unknown): string => {
      const t = typeof v === "string" ? Date.parse(v) : NaN;
      if (!Number.isFinite(t)) throw new StoreError(400, "start and end must be ISO timestamps");
      return new Date(t).toISOString();
    };
    const start = iso(input.start);
    const end = iso(input.end);
    const seconds = input.seconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) throw new StoreError(400, "seconds must be a number >= 0");
    const wall = (Date.parse(end) - Date.parse(start)) / 1000;
    if (wall < 0) throw new StoreError(400, "end is before start");
    if (!isMode(input.mode)) throw new StoreError(400, 'mode must be "blind" or "review"');
    // Active seconds can never exceed the wall-clock span of the session (1 s of slack for rounding).
    const entry: TimeEntry = { page: `sha256:${hex}`, mode: input.mode, start, end, seconds: Math.min(Math.round(seconds), Math.ceil(wall) + 1), annotator: this.annotator };
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, "timelog.jsonl"), `${JSON.stringify(entry)}\n`);
    return entry;
  }

  timelog(): TimeEntry[] {
    const p = join(this.dir, "timelog.jsonl");
    if (!existsSync(p)) return [];
    const out: TimeEntry[] = [];
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as TimeEntry);
      } catch {
        /* a torn last line after a crash: ignore it, the file stays append-only */
      }
    }
    return out;
  }

  /** Seconds worked per page hex (all sessions). */
  secondsByPage(): Map<string, number> {
    const out = new Map<string, number>();
    for (const e of this.timelog()) {
      const hex = e.page.replace(/^sha256:/, "");
      out.set(hex, (out.get(hex) ?? 0) + e.seconds);
    }
    return out;
  }

  /**
   * Exports the page as a contract-valid NodeLabels (`source=human`, `labeler.id = human@<annotator>`). Refuses, writing
   * nothing, while a unit of U is unlabeled; the refusal lists the missing units.
   */
  exportPage(page: PageData): { ok: true; path: string; doc: NodeLabels } | { ok: false; unlabeled: number[] } {
    const state = this.load(page.ref.hex, page.nodes.length);
    const plan = planExport(page.model, state);
    if (!plan.ok) return plan;
    const items = plan.items.map((it) => ({ unit_id: it.unit_id, y: it.y, confidence: 1, source: "human" as const, ...(it.reason ? { reason: it.reason } : {}) }));
    const body = {
      format: "gran-prix.node-labels" as const,
      format_version: "1.0.0" as const,
      snapshot_id: page.snapshot.snapshot_id,
      label_space: { kind: "multiclass" as const, classes: [...THREE_CLASS_SPACE.classes] },
      labeler: {
        id: `human@${this.annotator}`,
        kind: "human" as const,
        version: STUDIO_VERSION,
        params_sha256: artifactId({ tool: "gran-prix-studio", annotator: this.annotator, guide_version: GUIDE_VERSION, classes: LABEL_CLASSES }),
      },
      items,
      coverage: { n_labeled: items.length, n_candidates: page.model.units.length },
      // Extension fields (the schema is open): how the labels were made. Deterministic, so re-exporting the same labels keeps the id.
      studio: {
        mode: state.mode,
        guide_version: GUIDE_VERSION,
        n_doubt: items.filter((i) => i.reason?.includes("doubt")).length,
        n_mixed: items.filter((i) => i.reason?.includes("mixed")).length,
        draft: state.draft,
      },
    };
    const doc = { labels_id: contractId("node-labels", body as unknown as Record<string, unknown>) as Sha256, ...body } as NodeLabels;
    const check = validate("node-labels", doc);
    if (!check.ok) throw new StoreError(500, `internal: exported labels are not contract-valid: ${check.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    const path = join(this.dir, "export", "labels", `${page.ref.hex.slice(0, 12)}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp-${process.pid}`, `${canonicalJson(doc)}\n`);
    renameSync(`${path}.tmp-${process.pid}`, path);
    return { ok: true, path, doc };
  }
}
