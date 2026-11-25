import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keyToAction } from "../core/keys.js";
import { disagreements, effectiveLabels, progressOf } from "../core/labels.js";
import { buildModel } from "../core/model.js";
import { initialState, reduce, type Action, type ReduceContext, type StudioState } from "../core/reducer.js";
import { emptyLabelState, type LabelState, type Mode } from "../core/types.js";
import { api, type ExportResult, type PageDoc } from "./api.js";
import { FrameView } from "./FrameView.js";
import type { OverlayView } from "./frameOverlay.js";
import { GuidePanel } from "./GuidePanel.js";
import { KeyHelp, NodeInfo, NodeList, useFilter } from "./SidePanel.js";
import { formatDuration, useActiveTimer } from "./useActiveTimer.js";

interface Props {
  hex: string;
  /** Seconds already worked on the other pages (for the grand total). */
  otherSeconds: number;
  guideFile: boolean;
  onBack(): void;
}

/** Loads a page document and (re)mounts the labeler; also owns the mode switch, which needs a reload. */
export function PageView({ hex, otherSeconds, guideFile, onBack }: Props): React.ReactElement {
  const [doc, setDoc] = useState<PageDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let live = true;
    setDoc(null);
    api
      .page(hex)
      .then((d) => live && setDoc(d))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [hex, epoch]);
  if (error) return <div className="center error">Could not load the page: {error} <button onClick={onBack}>back</button></div>;
  if (!doc) return <div className="center">Loading page…</div>;
  return <Labeler key={`${hex}:${epoch}`} doc={doc} otherSeconds={otherSeconds} guideFile={guideFile} onBack={onBack} reload={() => setEpoch((e) => e + 1)} />;
}

const stateOf = (d: PageDoc): LabelState => ({ explicit: d.state.explicit, flags: d.state.flags });

function Labeler({ doc, otherSeconds, guideFile, onBack, reload }: { doc: PageDoc; otherSeconds: number; guideFile: boolean; onBack(): void; reload(): void }): React.ReactElement {
  const hex = doc.hex;
  const mode: Mode = doc.state.mode;
  const model = useMemo(() => buildModel(doc.nodes), [doc]);
  const draft = mode === "review" ? (doc.draft?.labels ?? null) : null;
  const draftName = doc.draft?.labeler_id ?? null;

  const [autoAdvance, setAutoAdvance] = useState(true);
  const [onlyDis, setOnlyDis] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [filter, setFilter] = useFilter();
  const [hover, setHover] = useState<number | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">("saved");
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const initialLabels = useMemo(() => stateOf(doc), [doc]);
  const ctx = useRef<ReduceContext>({ model, draft, autoAdvance });
  ctx.current = { model, draft, autoAdvance };
  const [st, setSt] = useState<StudioState>(() => {
    const s0 = initialState(initialLabels, { model });
    return reduce({ model, draft: null }, s0, { type: "nav", to: "first-unlabeled" });
  });
  const stRef = useRef(st);
  stRef.current = st;
  const dispatch = useCallback((a: Action) => setSt((s) => reduce(ctx.current, s, a)), []);

  const eff = useMemo(() => effectiveLabels(model, st.labels), [model, st.labels]);
  const progress = useMemo(() => progressOf(model, st.labels, eff), [model, st.labels, eff]);
  const nDis = useMemo(() => disagreements(model, eff, draft).length, [model, eff, draft]);

  // ---- autosave (debounced; Export and Back wait for it) ----
  const saved = useRef<LabelState>(initialLabels);
  const timer = useRef<number | null>(null);
  const saveNow = useCallback(async (): Promise<void> => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const labels = stRef.current.labels;
    if (labels === saved.current) return;
    setSaveStatus("saving");
    try {
      await api.save(hex, { labels, mode, draft: doc.draft ? { labels_id: doc.draft.labels_id, labeler_id: doc.draft.labeler_id } : null });
      saved.current = labels;
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }, [hex, mode, doc.draft]);
  useEffect(() => {
    if (st.labels === saved.current) return;
    setSaveStatus("saving");
    timer.current = window.setTimeout(() => void saveNow(), 300);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [st.labels, saveNow]);
  useEffect(
    () => () => {
      // leaving the page: best-effort write of anything still pending
      if (stRef.current.labels !== saved.current) void api.save(hex, { labels: stRef.current.labels, mode }).catch(() => undefined);
    },
    [hex, mode],
  );

  // ---- time ----
  const clock = useActiveTimer(hex, () => mode);
  const pageSeconds = doc.seconds + clock.seconds;

  // ---- export ----
  const doExport = useCallback(async (): Promise<void> => {
    setExportError(null);
    await saveNow();
    try {
      const r = await api.exportPage(hex);
      setExportResult(r);
      if (!r.ok && r.unlabeled[0]) dispatch({ type: "select", idx: r.unlabeled[0].unit_id });
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    }
  }, [hex, saveNow, dispatch]);

  // ---- keyboard (page document and frame document) ----
  const onKey = useCallback(
    (ev: KeyboardEvent): void => {
      const t = ev.target as HTMLElement | null;
      if (t && ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      const a = keyToAction(ev);
      if (a === null) return;
      ev.preventDefault();
      clock.touch();
      if (a.type === "ui") {
        if (a.what === "export") void doExport();
        else if (a.what === "guide") setShowGuide((v) => !v);
        else if (a.what === "help") setShowKeys((v) => !v);
        else if (a.what === "toggle-disagreements") setOnlyDis((v) => !v);
        else setAutoAdvance((v) => !v);
        return;
      }
      if (a.type === "accept-all-drafts" && !window.confirm("Accept the draft label for every unit that is still unlabeled? Your own labels stay.")) return;
      dispatch(a);
    },
    [dispatch, doExport, clock],
  );
  useEffect(() => {
    const k = (e: KeyboardEvent): void => onKey(e);
    const p = (): void => clock.touch();
    window.addEventListener("keydown", k);
    window.addEventListener("pointerdown", p);
    window.addEventListener("pointermove", p);
    return () => {
      window.removeEventListener("keydown", k);
      window.removeEventListener("pointerdown", p);
      window.removeEventListener("pointermove", p);
    };
  }, [onKey, clock]);

  const view: OverlayView = useMemo(
    () => ({ model, nodes: doc.nodes, eff, explicit: st.labels.explicit, flags: st.labels.flags, selected: st.selected, draft, onlyDisagreements: onlyDis && draft !== null }),
    [model, doc.nodes, eff, st.labels, st.selected, draft, onlyDis],
  );

  const changeMode = async (next: Mode): Promise<void> => {
    if (next === mode) return;
    const has = Object.keys(st.labels.explicit).length > 0;
    if (has && !window.confirm(`This page already has labels made in ${mode} mode. Switching to ${next} mode discards them. Continue?`)) return;
    await api.save(hex, { labels: emptyLabelState(), mode: next, reset: has });
    reload();
  };

  const done = progress.total > 0 && progress.labeled === progress.total;
  return (
    <div className="labeler">
      <header className="bar">
        <button
          onClick={() => {
            void saveNow().then(() => {
              clock.flush();
              onBack();
            });
          }}
          data-testid="back"
        >
          ← pages
        </button>
        <div className="title" title={doc.url}>
          <b>{doc.title || doc.url}</b> <span className="muted">{doc.category}</span>
        </div>
        <div className="modes" role="group" aria-label="mode">
          {(["blind", "review"] as const).map((m) => (
            <button key={m} className={m === mode ? "on" : ""} aria-pressed={m === mode} onClick={() => void changeMode(m)} data-testid={`mode-${m}`}>
              {m}
            </button>
          ))}
        </div>
        <div className="progress" data-testid="progress">
          <progress max={progress.total} value={progress.labeled} />
          <span data-testid="progress-text">
            {progress.labeled}/{progress.total} labeled
          </span>
          {progress.doubt > 0 && <span className="muted"> {progress.doubt}?</span>}
          {progress.mixed > 0 && <span className="muted"> {progress.mixed}~</span>}
          {draft && <span className="muted"> {nDis} differ from draft</span>}
        </div>
        <div className="time" title="active time on this page / all pages">
          {formatDuration(pageSeconds)} <span className="muted">/ {formatDuration(otherSeconds + pageSeconds)}</span>
        </div>
        <span className={`save ${saveStatus}`} data-testid="save-status">
          {saveStatus === "saved" ? "saved" : saveStatus === "saving" ? "saving…" : "SAVE FAILED"}
        </span>
        <button id="export" className={done ? "primary" : ""} onClick={() => void doExport()} data-testid="export">
          Export
        </button>
        <button onClick={() => setShowKeys((v) => !v)} aria-pressed={showKeys}>
          ? keys
        </button>
        <button onClick={() => setShowGuide((v) => !v)} aria-pressed={showGuide}>
          guide
        </button>
      </header>
      <div className="work">
        <FrameView
          src={api.frameUrl(hex)}
          view={view}
          onSelect={(i) => {
            clock.touch();
            dispatch({ type: "select", idx: i });
          }}
          onHover={setHover}
          onKey={onKey}
        />
        <aside className="side">
          {mode === "review" && !draft && <div className="panel warn">Review mode, but no draft exists for this page (no NodeLabelsSet and Readability had no answer). Label it by hand.</div>}
          <NodeInfo model={model} nodes={doc.nodes} eff={eff} labels={st.labels} selected={st.selected} draft={draft} draftName={draftName} />
          <div className="toggles">
            <label>
              <input type="checkbox" checked={autoAdvance} onChange={(e) => setAutoAdvance(e.target.checked)} /> auto-advance
            </label>
            {draft && (
              <label>
                <input type="checkbox" checked={onlyDis} onChange={(e) => setOnlyDis(e.target.checked)} /> only disagreements
              </label>
            )}
            <span className="muted hover">{hover !== null ? `hover: <${doc.nodes[hover]?.t}> n${hover}` : ""}</span>
          </div>
          {exportResult && <ExportPanel result={exportResult} onPick={(i) => dispatch({ type: "select", idx: i })} onClose={() => setExportResult(null)} />}
          {exportError && <div className="panel error">Export failed: {exportError}</div>}
          {showKeys && <KeyHelp />}
          {showGuide && <GuidePanel category={doc.category} hasGuideFile={guideFile} />}
          <NodeList model={model} nodes={doc.nodes} eff={eff} labels={st.labels} draft={draft} selected={st.selected} onSelect={(i) => dispatch({ type: "select", idx: i })} filter={filter} setFilter={setFilter} />
        </aside>
      </div>
    </div>
  );
}

function ExportPanel({ result, onPick, onClose }: { result: ExportResult; onPick(i: number): void; onClose(): void }): React.ReactElement {
  if (result.ok) {
    return (
      <div className="panel ok" data-testid="export-result" data-ok="true">
        <button className="x" onClick={onClose} aria-label="close">
          ×
        </button>
        Exported {result.n_labeled} labels (source=human).
        <br />
        <code>{result.path}</code>
        <br />
        <span className="muted">labels_id {result.labels_id.slice(0, 19)}…</span>
      </div>
    );
  }
  return (
    <div className="panel error" data-testid="export-result" data-ok="false">
      <button className="x" onClick={onClose} aria-label="close">
        ×
      </button>
      <b>Export refused:</b> {result.n_unlabeled} unit(s) of U have no label.
      <ul className="unlabeled-list">
        {result.unlabeled.map((u) => (
          <li key={u.unit_id} onClick={() => onPick(u.unit_id)}>
            n{u.unit_id} &lt;{u.tag}&gt; {u.text.slice(0, 60)}
          </li>
        ))}
      </ul>
      {result.n_unlabeled > result.unlabeled.length && <p className="muted">…and {result.n_unlabeled - result.unlabeled.length} more (press j to walk through them).</p>}
    </div>
  );
}
