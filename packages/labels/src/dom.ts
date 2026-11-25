import { JSDOM } from "jsdom";

/**
 * Loads the FLATTENED HTML of a page snapshot: open shadow roots inlined, scripts removed, and every
 * element carrying its `data-gp-id="n<idx>"` (idx = pre-order index of the snapshot node table).
 * Nothing runs: no scripts, no resources.
 */

/** Text nodes of these elements are never page text (same rule as the probe). */
export const SKIP_TEXT_TAGS: ReadonlySet<string> = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

/** One non-blank text node. `id` is "n<owner>#t<child index>". */
export interface TextUnit {
  id: string;
  owner: number;
  t: string;
}

export interface FlatPage {
  doc: Document;
  /** Elements by snapshot idx (those without a valid `data-gp-id` are not addressable and are left out). */
  elements: Map<number, Element>;
  /** Non-blank text nodes in document order. */
  texts: TextUnit[];
  /** Own text per element, whitespace collapsed and trimmed; only elements that own some. */
  ownText: Map<number, string>;
  /** Text of `<title>`, collapsed. */
  title: string;
}

const ID_RE = /^n(\d+)$/;

/** idx of the `data-gp-id` of an element, or null when it has none (or a malformed one). */
export function gpIdx(el: Element): number | null {
  const m = ID_RE.exec(el.getAttribute("data-gp-id") ?? "");
  return m ? Number(m[1]) : null;
}

export function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).href;
  } catch {
    return undefined;
  }
}

type Item = { el: Element } | { unit: TextUnit };

export function parseFlattened(html: string, url?: string): FlatPage {
  const dom = new JSDOM(html, { url: safeUrl(url) ?? "about:blank" });
  const doc = dom.window.document;
  const elements = new Map<number, Element>();
  const texts: TextUnit[] = [];
  const parts = new Map<number, string[]>();

  // Iterative pre-order walk (pages can be deep). Child elements and text nodes are pushed in reverse
  // so they pop in document order: `<p>text<a>x</a>tail</p>` yields text, a, tail.
  const stack: Item[] = doc.documentElement ? [{ el: doc.documentElement }] : [];
  while (stack.length > 0) {
    const it = stack.pop() as Item;
    if ("unit" in it) {
      texts.push(it.unit);
      const list = parts.get(it.unit.owner);
      if (list) list.push(it.unit.t);
      else parts.set(it.unit.owner, [it.unit.t]);
      continue;
    }
    const el = it.el;
    const idx = gpIdx(el);
    if (idx !== null) elements.set(idx, el);
    const skip = SKIP_TEXT_TAGS.has(el.tagName);
    const kids = el.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) {
      const n = kids[i] as Node;
      if (n.nodeType === 1) stack.push({ el: n as Element });
      else if (n.nodeType === 3 && idx !== null && !skip && (n.nodeValue ?? "").trim() !== "") {
        stack.push({ unit: { id: `n${idx}#t${i}`, owner: idx, t: n.nodeValue ?? "" } });
      }
    }
  }
  const ownText = new Map<number, string>();
  for (const [idx, p] of parts) ownText.set(idx, collapse(p.join("")));
  return { doc, elements, texts, ownText, title: collapse(doc.title) };
}
