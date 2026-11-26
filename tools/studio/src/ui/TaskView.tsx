import { useCallback, useEffect, useState } from "react";
import { api, type TaskPageRow, type TaskSummary } from "./api.js";
import { CalibrationView } from "./CalibrationView.js";
import { taskName } from "./TaskHome.js";
import { formatDuration } from "./useActiveTimer.js";

interface Props {
  task: string;
  onOpenPage(hex: string): void;
  onHome(): void;
}

/** One task: its pages with progress (queue tasks) or its 12 groups (calibration). Refuses to show a closed task. */
export function TaskView({ task, onOpenPage, onHome }: Props): React.ReactElement {
  if (task === "calibration") return <CalibrationView onOpenPage={onOpenPage} onHome={onHome} />;
  return <QueueView task={task} onOpenPage={onOpenPage} onHome={onHome} />;
}

function QueueView({ task, onOpenPage, onHome }: Props): React.ReactElement {
  const [data, setData] = useState<(TaskSummary & { pages: TaskPageRow[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .task(task)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [task]);
  useEffect(load, [load]);

  const header = (
    <header className="bar">
      <button onClick={onHome} data-testid="back-home">
        ← tarefas
      </button>
      <h1>{taskName(task)}</h1>
      {data && <span className={`badge mode-${data.mode}`}>{data.mode === "blind" ? "cego" : "revisão"}</span>}
      <span className="grow" />
      {data && (
        <span data-testid="task-progress">
          {data.done}/{data.total} páginas feitas · {formatDuration(data.seconds)}
        </span>
      )}
      {data && (
        <button
          onClick={() =>
            void api
              .exportTask(task)
              .then((r) => setMsg(`Exportadas ${r.exported.length} página(s) com task=${r.task} e plano ${r.plan_sha256?.slice(0, 19) ?? "-"}…; ${r.refused.length} recusada(s) por unidades sem rótulo${r.skipped.length ? `; ${r.skipped.length} fora (ausentes ou em conflito)` : ""}.`))
              .then(load)
              .catch((e: unknown) => setMsg(e instanceof Error ? e.message : String(e)))
          }
          data-testid="export-task"
        >
          Exportar a tarefa
        </button>
      )}
    </header>
  );
  if (error) {
    return (
      <div className="list-view">
        {header}
        <p className="panel error" role="alert" data-testid="task-error">
          {error}
        </p>
      </div>
    );
  }
  if (!data) return <div className="center">Carregando…</div>;
  return (
    <div className="list-view" data-testid="task-view">
      {header}
      <p className="muted task-meta">
        plano <code>{data.plan_sha256?.slice(0, 19)}…</code>
        {data.not_before && <> · abre em {data.not_before}</>}
        {data.mode === "blind" ? " · o servidor não entrega rascunho, votos de extrator nem rótulo de LLM nesta tarefa" : " · o rascunho aparece; você confirma ou muda cada unidade"}
      </p>
      {msg && (
        <p className="panel" role="status">
          {msg}
        </p>
      )}
      <table className="pages">
        <thead>
          <tr>
            <th>página</th>
            <th>categoria</th>
            <th>split</th>
            <th>progresso (rotulado / U)</th>
            <th>tempo</th>
            <th>estado</th>
          </tr>
        </thead>
        <tbody>
          {data.pages.map((p) => (
            <tr key={p.hex} data-testid="page-row" data-hex={p.hex}>
              <td>
                {p.missing || p.conflict ? (
                  <span>{p.url}</span>
                ) : (
                  <a
                    href={`#/t/${task}/${p.hex}`}
                    onClick={(e) => {
                      e.preventDefault();
                      onOpenPage(p.hex);
                    }}
                  >
                    {p.title || p.url}
                  </a>
                )}
                <div className="muted">{p.url}</div>
                {p.error && <div className="error">{p.error}</div>}
              </td>
              <td>{p.category}</td>
              <td>{p.split}</td>
              <td>
                <progress max={p.units ?? 0} value={p.labeled ?? 0} /> {p.labeled ?? 0}/{p.units ?? 0}
              </td>
              <td>{formatDuration(p.seconds ?? 0)}</td>
              <td>{p.missing ? "não está no data dir (rode o collect)" : p.conflict ? `conflito: página da ${p.conflict}` : p.exported ? "exportada" : p.complete ? "completa, não exportada" : (p.labeled ?? 0) > 0 ? "em andamento" : "não começada"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
