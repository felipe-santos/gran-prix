import { useCallback, useEffect, useState } from "react";
import type { Mode } from "../core/types.js";
import { api, type PageRow } from "./api.js";
import { formatDuration } from "./useActiveTimer.js";

interface Props {
  annotator: string;
  onOpen(hex: string): void;
  refreshKey: number;
  onTotals(otherSeconds: (hex: string) => number): void;
}

/** The pages of the data dir with progress (labeled / |U|), mode and time; the entry point of a labeling session. */
export function PageList({ annotator, onOpen, refreshKey, onTotals }: Props): React.ReactElement {
  const [rows, setRows] = useState<PageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .pages()
      .then((r) => {
        setRows(r.pages);
        const total = r.pages.reduce((s, p) => s + (p.seconds ?? 0), 0);
        onTotals((hex) => total - (r.pages.find((p) => p.hex === hex)?.seconds ?? 0));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [onTotals]);
  useEffect(load, [load, refreshKey]);

  if (error) return <div className="center error">Could not list pages: {error}</div>;
  if (!rows) return <div className="center">Loading…</div>;

  const totalSeconds = rows.reduce((s, r) => s + (r.seconds ?? 0), 0);
  const totalUnits = rows.reduce((s, r) => s + (r.units ?? 0), 0);
  const totalLabeled = rows.reduce((s, r) => s + (r.labeled ?? 0), 0);
  const setMode = async (r: PageRow, mode: Mode): Promise<void> => {
    if (r.mode === mode) return;
    const has = (r.labeled ?? 0) > 0;
    if (has && !window.confirm(`${r.url} already has labels in ${r.mode} mode. Switching to ${mode} discards them. Continue?`)) return;
    try {
      await api.save(r.hex, { labels: { explicit: {}, flags: {} }, mode, reset: has });
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="list-view">
      <header className="bar">
        <h1>Gran-Prix Studio</h1>
        <span className="muted">annotator</span> <b data-testid="annotator">{annotator}</b>
        <span className="grow" />
        <span data-testid="total-progress">
          {totalLabeled}/{totalUnits} units labeled in {rows.length} page(s)
        </span>
        <span title="active labeling time, all pages" data-testid="total-time">
          {formatDuration(totalSeconds)}
        </span>
        <button
          onClick={() =>
            void api.exportAll().then((r) => setMsg(`Exported ${r.exported.length} page(s); ${r.refused.length} refused (unlabeled units: ${r.refused.map((x) => x.unlabeled).join(", ") || "none"}).`)).then(load)
          }
        >
          Export all complete pages
        </button>
      </header>
      {msg && (
        <p className="panel" role="status">
          {msg}
        </p>
      )}
      {rows.length === 0 && <p className="center">No SnapshotSet found in this data dir. Run a `collect` stage with `gp run` first.</p>}
      <table className="pages">
        <thead>
          <tr>
            <th>page</th>
            <th>category</th>
            <th>mode</th>
            <th>progress (labeled / U)</th>
            <th>doubt</th>
            <th>time</th>
            <th>state</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.hex} data-testid="page-row" data-hex={r.hex}>
              <td>
                <a
                  href={`#${r.hex}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpen(r.hex);
                  }}
                >
                  {r.title || r.url}
                </a>
                <div className="muted">{r.url}</div>
                {r.error && <div className="error">{r.error}</div>}
              </td>
              <td>{r.category}</td>
              <td>
                <div className="modes" role="group">
                  {(["blind", "review"] as const).map((m) => (
                    <button key={m} className={r.mode === m ? "on" : ""} aria-pressed={r.mode === m} onClick={() => void setMode(r, m)}>
                      {m}
                    </button>
                  ))}
                </div>
              </td>
              <td>
                <progress max={r.units ?? 0} value={r.labeled ?? 0} /> {r.labeled ?? 0}/{r.units ?? 0}
              </td>
              <td>{r.doubt ?? 0}</td>
              <td>{formatDuration(r.seconds ?? 0)}</td>
              <td>{r.exported ? "exported" : r.complete ? "complete, not exported" : (r.labeled ?? 0) > 0 ? "in progress" : "not started"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
