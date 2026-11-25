import { useState } from "react";
import { CATEGORIES, CLASS_SUMMARY, DECISION_ORDER, GUIDE_FILE, GUIDE_QUESTION, TIE_BREAKS, TRANSVERSAL } from "./guideData.js";
import { api } from "./api.js";

interface Props {
  category: string;
  hasGuideFile: boolean;
}

/** Quick reference of the annotation guide: a summary to look at while labeling, with the section numbers of the real guide. */
export function GuidePanel({ category, hasGuideFile }: Props): React.ReactElement {
  const known = CATEGORIES.find((c) => c.id === category)?.id ?? CATEGORIES[0]?.id ?? "article";
  const [tab, setTab] = useState(known);
  const cat = CATEGORIES.find((c) => c.id === tab);
  return (
    <section className="panel guide" aria-label="Guide quick reference">
      <h3>
        Guide quick reference <span className="muted">(summary, v1.0-draft)</span>
      </h3>
      <p className="question">{GUIDE_QUESTION}</p>
      <dl className="classes">
        {CLASS_SUMMARY.map((c) => (
          <div key={c.cls} className={`cls-row ${c.cls}`}>
            <dt>
              <span className={`badge ${c.cls}`}>{c.cls[0]?.toUpperCase()}</span> {c.key} {c.cls}
            </dt>
            <dd>{c.text}</dd>
          </div>
        ))}
      </dl>
      <h4>Decision order (guide 1.1)</h4>
      <ol>
        {DECISION_ORDER.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ol>
      <h4>Tie-breaks</h4>
      <ul>
        {TIE_BREAKS.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
      <h4>By category</h4>
      <div className="tabs" role="tablist">
        {CATEGORIES.map((c) => (
          <button key={c.id} role="tab" aria-selected={c.id === tab} className={c.id === tab ? "on" : ""} onClick={() => setTab(c.id)}>
            {c.id}
          </button>
        ))}
      </div>
      {cat && (
        <div className="cat">
          <p className="muted">
            {cat.title}, guide section {cat.section}
          </p>
          <p>
            <b className="m">main</b> {cat.main}
          </p>
          <p>
            <b className="s">support</b> {cat.support}
          </p>
          <p>
            <b className="n">noise</b> {cat.noise}
          </p>
          <ul>
            {cat.cases.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      <h4>Always</h4>
      <ul>
        {TRANSVERSAL.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
      <p className="muted">
        Full text: <code>{GUIDE_FILE}</code> (sections 1.1, 2.2 to 2.4, 3, 4.x, 5)
        {hasGuideFile && (
          <>
            {" "}
            <a href={api.guideUrl()} target="_blank" rel="noreferrer">
              open as text
            </a>
          </>
        )}
        . The guide is frozen: this panel only summarizes it.
      </p>
    </section>
  );
}
