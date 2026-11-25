import { useMemo, useState } from "react";
import { KEYMAP_DOC } from "../core/keys.js";
import { labeledBelow, type Draft, type Effective } from "../core/labels.js";
import type { PageModel } from "../core/model.js";
import type { Flag, LabelClass, LabelState, LightNode } from "../core/types.js";

const LETTER: Record<LabelClass, string> = { main: "M", support: "S", noise: "N" };

export const Badge = ({ cls, ghost = false }: { cls: LabelClass; ghost?: boolean }): React.ReactElement => (
  <span className={`badge ${cls}${ghost ? " ghost" : ""}`} title={cls}>
    {ghost ? `[${LETTER[cls]}]` : LETTER[cls]}
  </span>
);

const flagMarks = (flags: readonly Flag[]): string => (flags.includes("doubt") ? "?" : "") + (flags.includes("mixed") ? "~" : "");
const snippet = (s: string, n = 70): string => (s.length > n ? `${s.slice(0, n)}…` : s);

interface InfoProps {
  model: PageModel;
  nodes: readonly LightNode[];
  eff: Effective;
  labels: LabelState;
  selected: number | null;
  draft: Draft | null;
  draftName: string | null;
}

/** What the selected element is, what label it has (explicit or inherited), its flags and, in review mode, its draft. */
export function NodeInfo({ model, nodes, eff, labels, selected, draft, draftName }: InfoProps): React.ReactElement {
  if (selected === null) return <section className="panel">Nothing selected. Click an outlined element or press j.</section>;
  const n = nodes[selected];
  const cls = eff.cls[selected] ?? null;
  const from = eff.from[selected] as number;
  const explicit = labels.explicit[selected];
  const flags = labels.flags[selected] ?? [];
  const below = labeledBelow(model, eff, selected);
  const d = draft?.[selected] ?? null;
  return (
    <section className="panel" aria-label="Selected element" data-testid="node-info">
      <h3>
        <code>
          {n?.t}
          {n?.i ? `#${n.i}` : ""}
          {n?.c ? `.${n.c.split(/\s+/).join(".")}` : ""}
        </code>{" "}
        <span className="muted">n{selected}</span>
      </h3>
      <p className="own-text">{n?.x ? snippet(n.x, 160) : <i className="muted">no own text (container)</i>}</p>
      <p>
        {cls ? (
          <>
            <Badge cls={cls} /> <b>{cls}</b>{" "}
            <span className="muted">{explicit ? "explicit" : from >= 0 ? `inherited from n${from} <${nodes[from]?.t}>` : ""}</span>
          </>
        ) : (
          <span className="unlabeled">unlabeled</span>
        )}{" "}
        {flags.map((f) => (
          <span key={f} className="flag">
            {f}
          </span>
        ))}
      </p>
      {draft && (
        <p className={d && cls && d !== cls ? "disagree" : ""}>
          Draft{draftName ? ` (${draftName})` : ""}: {d ? <Badge cls={d} ghost /> : <span className="muted">none for this node</span>}
          {d && cls && d !== cls ? <b> differs from your label</b> : null}
          {d && cls && d === cls ? <span className="muted"> agrees</span> : null}
        </p>
      )}
      <p className="muted">
        {model.inU[selected] === 0 ? "container / outside U" : model.inU[selected] === 2 ? "unit of U (collapsed disclosure)" : "unit of U"}; {below.labeled}/{below.units} units labeled below
      </p>
    </section>
  );
}

type Filter = "all" | "unlabeled" | "flagged" | "disagreements";

interface ListProps {
  model: PageModel;
  nodes: readonly LightNode[];
  eff: Effective;
  labels: LabelState;
  draft: Draft | null;
  selected: number | null;
  onSelect(idx: number): void;
  filter: Filter;
  setFilter(f: Filter): void;
}

export function NodeList({ model, nodes, eff, labels, draft, selected, onSelect, filter, setFilter }: ListProps): React.ReactElement {
  const rows = useMemo(
    () =>
      model.units.filter((u) => {
        const c = eff.cls[u] ?? null;
        if (filter === "unlabeled") return c === null;
        if (filter === "flagged") return (labels.flags[u] ?? []).length > 0;
        if (filter === "disagreements") return c !== null && draft?.[u] !== undefined && draft[u] !== c;
        return true;
      }),
    [model, eff, labels, draft, filter],
  );
  const filters: Filter[] = draft ? ["all", "unlabeled", "flagged", "disagreements"] : ["all", "unlabeled", "flagged"];
  return (
    <section className="panel list" aria-label="Units of U">
      <div className="tabs">
        {filters.map((f) => (
          <button key={f} className={f === filter ? "on" : ""} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
        <span className="muted">{rows.length}</span>
      </div>
      <ul data-testid="unit-list">
        {rows.map((u) => {
          const c = eff.cls[u] ?? null;
          const d = draft?.[u] ?? null;
          return (
            <li key={u} className={u === selected ? "sel" : ""} onClick={() => onSelect(u)}>
              {c ? <Badge cls={c} /> : d ? <Badge cls={d} ghost /> : <span className="badge none">·</span>}
              <span className="marks">{flagMarks(labels.flags[u] ?? [])}</span>
              {c && d && c !== d ? <span className="disagree" title="differs from the draft">{`≠${LETTER[d]}`}</span> : null}
              <span className="tag">{nodes[u]?.t}</span>
              <span className="txt">{snippet(nodes[u]?.x ?? "")}</span>
              {model.inU[u] === 2 ? <span className="muted"> (collapsed)</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function KeyHelp(): React.ReactElement {
  return (
    <section className="panel keys" aria-label="Keyboard map">
      <h3>Keyboard</h3>
      <table>
        <tbody>
          {KEYMAP_DOC.map((k) => (
            <tr key={k.keys}>
              <th>
                <kbd>{k.keys}</kbd>
              </th>
              <td>{k.does}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        Markers: <b>M</b> main, <b>S</b> support, <b>N</b> noise, <b>?</b> doubt, <b>~</b> mixed, <b>[M]</b> the draft's proposal (not yet yours), <b>S≠M</b> your S against the draft's M.
      </p>
    </section>
  );
}

export const useFilter = (): [Filter, (f: Filter) => void] => useState<Filter>("all");
export type { Filter };
