/**
 * Truth importer (`label_source: "human"`): applies ordered CSS-selector rules, the format of
 * `fixtures/pages/*.truth.json`, to the flattened HTML of a snapshot.
 *
 * The label of an element is the label of the nearest ancestor-or-self matched by a rule; on the same
 * element the LATER rule wins. Rules run on the flattened tree (open shadow roots inlined as children of
 * their host), which is also the composed tree the ids follow.
 */
import { THREE_CLASS_SPACE } from "@gran-prix/contracts";
import { gpIdx, parseFlattened, type FlatPage } from "./dom.js";

export type TruthClass = "main" | "support" | "noise";

export interface TruthRule {
  selector: string;
  label: TruthClass;
}

export interface TruthImport {
  /** Class per element idx; null when no rule matched the element or any ancestor. */
  labels: Map<number, TruthClass | null>;
  /** Elements (other than `<title>`) that own text but got no label: the lint, empty for a complete truth file. */
  uncovered: number[];
  /** Selectors that matched no element in this page. */
  deadRules: string[];
  /** Selectors the engine could not parse. */
  invalidRules: string[];
  page: FlatPage;
}

const CLASSES = new Set<string>(THREE_CLASS_SPACE.classes);

export function assertTruthRules(rules: unknown): asserts rules is TruthRule[] {
  if (!Array.isArray(rules)) throw new TypeError("truth rules must be an array of { selector, label }");
  for (const [i, r] of rules.entries()) {
    const rule = r as Partial<TruthRule> | null;
    if (!rule || typeof rule.selector !== "string" || rule.selector === "" || typeof rule.label !== "string" || !CLASSES.has(rule.label)) {
      throw new TypeError(`truth rule ${i} must be { selector: string, label: ${[...CLASSES].join("|")} }`);
    }
  }
}

export function importTruth(html: string, rules: readonly TruthRule[], opts: { url?: string } = {}): TruthImport {
  const page = parseFlattened(html, opts.url);
  const invalid = new Set<string>();
  const labels = new Map<number, TruthClass | null>();

  /** Index of the last rule matching `el` (-1 when none). Invalid selectors are recorded once and skipped. */
  const lastMatch = (el: Element): number => {
    for (let r = rules.length - 1; r >= 0; r--) {
      const sel = (rules[r] as TruthRule).selector;
      if (invalid.has(sel)) continue;
      try {
        if (el.matches(sel)) return r;
      } catch {
        invalid.add(sel);
      }
    }
    return -1;
  };

  // Top-down in pre-order: label = own match, else the parent's label (nearest ancestor-or-self).
  const walk: Array<{ el: Element; inherited: TruthClass | null }> = page.doc.documentElement
    ? [{ el: page.doc.documentElement, inherited: null }]
    : [];
  while (walk.length > 0) {
    const { el, inherited } = walk.pop() as { el: Element; inherited: TruthClass | null };
    const r = lastMatch(el);
    const label: TruthClass | null = r >= 0 ? (rules[r] as TruthRule).label : inherited;
    const idx = gpIdx(el);
    if (idx !== null) labels.set(idx, label);
    const kids = el.children;
    for (let i = kids.length - 1; i >= 0; i--) walk.push({ el: kids[i] as Element, inherited: label });
  }

  // `<title>` is document metadata, not page content: the spike's lint leaves it out too.
  const uncovered = [...page.ownText.keys()]
    .filter((i) => (labels.get(i) ?? null) === null && page.elements.get(i)?.tagName !== "TITLE")
    .sort((a, b) => a - b);
  // A rule is "dead" when it matches no element at all (an invalid selector is reported separately).
  const deadRules = rules.flatMap((r) => {
    if (invalid.has(r.selector)) return [];
    try {
      return page.doc.querySelector(r.selector) ? [] : [r.selector];
    } catch {
      invalid.add(r.selector);
      return [];
    }
  });
  return { labels, uncovered, deadRules, invalidRules: [...invalid], page };
}

/** Class index in the ADR-006 3-class space (main = 0, support = 1, noise = 2). */
export function classIndex(c: TruthClass): number {
  return THREE_CLASS_SPACE.classes.indexOf(c);
}
