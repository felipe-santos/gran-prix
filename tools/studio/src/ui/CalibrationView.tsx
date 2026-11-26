import { useCallback, useEffect, useState } from "react";
import { api, type CalGroup, type CalResult, type CalibrationSummary } from "./api.js";
import type { ExtraCtx } from "./PageView.js";

const CLASS_PT: Record<string, string> = { main: "principal", support: "suporte", noise: "ruído" };
const pt = (c: string): string => CLASS_PT[c] ?? c;

/** Binary and 3-class score with the criterion of the guide (section 7). */
function Score({ s }: { s: CalibrationSummary }): React.ReactElement {
  return (
    <span data-testid="cal-score">
      keep × drop <b>{s.binary_correct}/{s.total}</b> (precisa {s.binary_needed}) · 3 classes <b>{s.three_correct}/{s.total}</b> (precisa {s.three_needed}) · {s.finished}/{s.total} grupos terminados
      {s.passed === true && <b className="ok-text"> · critério atingido</b>}
      {s.passed === false && <b className="error"> · critério NÃO atingido: discuta os erros</b>}
    </span>
  );
}

/** The errors of a finished group, for discussion. The expected label is shown only here, after the group is finished. */
function Result({ r }: { r: CalResult }): React.ReactElement {
  return (
    <div className="cal-result" data-testid="cal-result" data-binary={r.binary_ok} data-three={r.three_ok}>
      <div>
        keep × drop: <b className={r.binary_ok ? "ok-text" : "error"}>{r.binary_ok ? "certo" : `${r.binary_errors} erro(s)`}</b> · 3 classes: <b className={r.three_ok ? "ok-text" : "error"}>{r.three_ok ? "certo" : `${r.three_errors} erro(s)`}</b> · {r.n_units} unidade(s)
        {r.n_outside_targets > 0 && <span className="muted"> · {r.n_outside_targets} alvo(s) fora de U (nada a rotular: certo)</span>}
      </div>
      {r.errors.length > 0 && (
        <table className="cal-errors">
          <thead>
            <tr>
              <th>alvo</th>
              <th>elemento</th>
              <th>esperado</th>
              <th>seu rótulo</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {r.errors.map((e) => (
              <tr key={`${e.fixture}:${e.unit_id}`}>
                <td>
                  {e.fixture} <code>{e.selector}</code>
                </td>
                <td>
                  n{e.unit_id} &lt;{e.tag}&gt; {e.text.slice(0, 60)}
                </td>
                <td>{pt(e.expected)}</td>
                <td>{pt(e.given)}</td>
                <td>{e.binary_ok ? "só nas 3 classes" : "keep × drop"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Targets({ g }: { g: CalGroup }): React.ReactElement {
  return (
    <ul className="cal-targets">
      {g.targets.map((t) => (
        <li key={`${t.fixture}${t.selector}`}>
          <b>{t.fixture}</b> <code>{t.selector}</code> <span className="muted">{t.what}</span>
        </li>
      ))}
    </ul>
  );
}

/** The 12 groups: what to label, progress, and the result of the finished ones. */
export function CalibrationView({ onOpenPage, onHome }: { onOpenPage(hex: string): void; onHome(): void }): React.ReactElement {
  const [data, setData] = useState<{ groups: CalGroup[]; summary: CalibrationSummary } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .calibration()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);
  if (error) return <div className="center error">Não foi possível carregar a calibração: {error}</div>;
  if (!data) return <div className="center">Carregando…</div>;
  const finish = (n: number): void => {
    setMsg(null);
    api
      .finishGroup(n)
      .then(load)
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="list-view" data-testid="calibration-view">
      <header className="bar">
        <button onClick={onHome} data-testid="back-home">
          ← tarefas
        </button>
        <h1>Calibração (guia §7)</h1>
        <span className="badge mode-blind">cego</span>
        <span className="grow" />
        <Score s={data.summary} />
      </header>
      <p className="muted task-meta">
        Rotule, sem consultar nenhum <code>truth.json</code>, os elementos de cada grupo. Ao terminar um grupo, o Studio mostra o esperado e os seus erros; antes disso nada do esperado sai do servidor.
        Alvos que não aparecem para rotular (invisíveis) estão fora de U e não pedem nada.
      </p>
      {msg && (
        <p className="panel error" role="alert">
          {msg}
        </p>
      )}
      {data.groups.map((g) => (
        <section className="panel cal-group" key={g.n} data-testid="cal-group" data-n={g.n} data-finished={g.finished}>
          <h3>
            Grupo {g.n}: {g.title}
          </h3>
          <Targets g={g} />
          {!g.available && <p className="error">Faltam fixtures no data dir: rode o collect em <code>fixtures/pages</code>.</p>}
          <p>
            {g.pages.map((p) =>
              p.hex ? (
                <button key={p.fixture} onClick={() => onOpenPage(p.hex as string)} data-testid={`open-${p.fixture}`}>
                  abrir {p.fixture}
                </button>
              ) : null,
            )}{" "}
            <progress max={g.units_total} value={g.units_labeled} /> {g.units_labeled}/{g.units_total} unidades rotuladas{" "}
            {!g.finished && (
              <button className={g.units_total > 0 && g.units_labeled === g.units_total ? "primary" : ""} disabled={!g.available || g.units_labeled < g.units_total} onClick={() => finish(g.n)} data-testid="finish-group">
                Terminar grupo {g.n}
              </button>
            )}
          </p>
          {g.result && <Result r={g.result} />}
        </section>
      ))}
    </div>
  );
}

/** Beside the labeler of a calibration page: the groups that use this page, with the finish button and the result. */
export function CalibrationSide({ ctx }: { ctx: ExtraCtx }): React.ReactElement {
  const [data, setData] = useState<{ groups: CalGroup[]; summary: CalibrationSummary } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .calibration()
      .then(setData)
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : String(e)));
  }, []);
  // progress is the server's: reload whenever an autosave lands
  useEffect(() => {
    if (ctx.saveStatus === "saved") load();
  }, [ctx.saveStatus, ctx.labelsVersion, load]);
  const mine = data?.groups.filter((g) => g.pages.some((p) => p.hex === ctx.hex)) ?? [];
  return (
    <div className="panel" data-testid="cal-side">
      <h3>Grupos desta página</h3>
      {data && <div className="muted">{data.summary.finished}/12 grupos terminados</div>}
      {msg && <div className="error">{msg}</div>}
      {mine.map((g) => (
        <div key={g.n} className="cal-group" data-testid="cal-side-group" data-n={g.n} data-finished={g.finished}>
          <b>
            Grupo {g.n}: {g.title}
          </b>
          <Targets g={g} />
          <div>
            {g.units_labeled}/{g.units_total} unidades rotuladas{" "}
            {!g.finished && (
              <button
                className={g.units_labeled === g.units_total ? "primary" : ""}
                disabled={ctx.saveStatus !== "saved" || g.units_labeled < g.units_total}
                onClick={() =>
                  void api
                    .finishGroup(g.n)
                    .then(load)
                    .catch((e: unknown) => setMsg(e instanceof Error ? e.message : String(e)))
                }
                data-testid="finish-group"
              >
                Terminar grupo {g.n}
              </button>
            )}
          </div>
          {g.result && <Result r={g.result} />}
        </div>
      ))}
    </div>
  );
}
