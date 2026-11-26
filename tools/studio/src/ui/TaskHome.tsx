import { useEffect, useState } from "react";
import { api, type TaskSummary } from "./api.js";
import { formatDuration } from "./useActiveTimer.js";

/** What the owner is told about each task, in the order of the protocol (calibration, prompt-dev, audit, retest, ...). */
export const TASK_INFO: Record<string, { name: string; what: string; minutes: string }> = {
  calibration: { name: "Calibração", what: "12 grupos dos fixtures sintéticos, cego. Critério: 11 de 12 em keep × drop e 10 de 12 em 3 classes (guia §7).", minutes: "cerca de 30 min" },
  "prompt-dev": { name: "Prompt-dev", what: "10 páginas do treino, rótulo seu do zero, cego (protocolo §5.1, passo 2).", minutes: "cerca de 7 min por página" },
  audit: { name: "Auditoria", what: "30 páginas do teste, rótulo seu do zero, cego ao LLM e aos extratores (§5.1, passo 3).", minutes: "cerca de 7 min por página" },
  retest: { name: "Reteste", what: "10 páginas da auditoria rotuladas de novo, cego ao primeiro rótulo. Só abre ≥ 7 dias depois (§5.4).", minutes: "cerca de 6 min por página" },
  "train-sample": { name: "Amostra do treino", what: "Revisão completa do rascunho em cerca de 9 páginas do treino (§5.1, passo 7).", minutes: "cerca de 4 min por página" },
  "test-review": { name: "Revisão do teste", what: "Rascunho do LLM revisado em 100% dos nós das páginas restantes do teste (§5.1, passo 6).", minutes: "cerca de 4 min por página" },
};
const ORDER = Object.keys(TASK_INFO);

export const taskName = (id: string): string => TASK_INFO[id]?.name ?? id;

export function TaskHome({ onOpen, onAll }: { onOpen(hash: string): void; onAll(): void }): React.ReactElement {
  const [data, setData] = useState<{ tasks: TaskSummary[]; invalid: Array<{ file: string; error: string }> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .tasks()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  if (error) return <div className="center error">Não foi possível listar as tarefas: {error}</div>;
  if (!data) return <div className="center">Carregando…</div>;
  const tasks = [...data.tasks].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const total = tasks.reduce((s, t) => s + t.seconds, 0);
  return (
    <div className="list-view" data-testid="task-home">
      <header className="bar">
        <h1>Gran-Prix Studio</h1>
        <span className="grow" />
        <span title="tempo ativo de rotulagem, todas as tarefas" data-testid="tasks-total-time">
          {formatDuration(total)}
        </span>
        <button onClick={onAll}>Todas as páginas (modo livre)</button>
      </header>
      {data.invalid.length > 0 && (
        <div className="panel error" role="alert" data-testid="invalid-queues">
          <b>Filas recusadas</b> (fora do formato; não viram tarefa):
          <ul>
            {data.invalid.map((i) => (
              <li key={i.file}>
                <code>{i.file}</code>: {i.error}
              </li>
            ))}
          </ul>
        </div>
      )}
      <table className="pages">
        <thead>
          <tr>
            <th>tarefa</th>
            <th>modo</th>
            <th>progresso (feitas / total)</th>
            <th>tempo</th>
            <th>próxima página</th>
            <th>estado</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} data-testid="task-row" data-task={t.id}>
              <td>
                <a
                  href={`#/t/${t.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpen(`/t/${t.id}`);
                  }}
                >
                  {taskName(t.id)}
                </a>
                <div className="muted">{TASK_INFO[t.id]?.what}</div>
                <div className="muted">{TASK_INFO[t.id]?.minutes}</div>
              </td>
              <td>
                <span className={`badge mode-${t.mode}`}>{t.mode === "blind" ? "cego" : "revisão"}</span>
              </td>
              <td>
                <progress max={Math.max(t.total, 1)} value={t.done} /> <span data-testid="task-progress">{t.done}/{t.total}</span>
                {t.kind === "calibration" && <div className="muted">{t.done} de 12 grupos terminados</div>}
              </td>
              <td>{formatDuration(t.seconds)}</td>
              <td>
                <Next t={t} onOpen={onOpen} />
              </td>
              <td>{stateOf(t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {tasks.length === 1 && <p className="muted">Nenhuma fila em <code>data/labeling/queues/</code> ainda: só a calibração está disponível.</p>}
    </div>
  );
}

function Next({ t, onOpen }: { t: TaskSummary; onOpen(hash: string): void }): React.ReactElement {
  if (t.locked) return <span className="muted">fechada</span>;
  if (t.kind === "calibration") {
    return t.next?.group ? (
      <a href="#/t/calibration" onClick={(e) => (e.preventDefault(), onOpen("/t/calibration"))}>
        grupo {t.next.group}
      </a>
    ) : (
      <span className="muted">{t.done >= t.total ? "—" : "indisponível"}</span>
    );
  }
  const hex = t.next?.hex;
  if (!hex) return <span className="muted">—</span>;
  return (
    <a href={`#/t/${t.id}/${hex}`} onClick={(e) => (e.preventDefault(), onOpen(`/t/${t.id}/${hex}`))}>
      {t.next?.title || t.next?.url}
    </a>
  );
}

function stateOf(t: TaskSummary): string {
  if (t.locked) return `fechada até ${t.not_before ?? ""}`;
  if (t.kind === "calibration") {
    if (!t.available && t.done === 0) return "faltam fixtures no data dir (rode o collect nos fixtures)";
    const s = t.calibration;
    if (s?.passed === true) return "aprovado";
    if (s?.passed === false) return "critério não atingido";
    return t.done > 0 ? "em andamento" : "não começada";
  }
  const extra = [t.missing ? `${t.missing} página(s) fora do data dir` : "", t.conflicts ? `${t.conflicts} conflito(s) com tarefa cega` : ""].filter(Boolean).join("; ");
  const base = t.done >= t.total && t.total > 0 ? "concluída" : t.done > 0 ? "em andamento" : "não começada";
  return extra ? `${base} (${extra})` : base;
}
