import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { ACT_CONTAINER, ACT_DROP, ACT_FULL, planPage, type Act } from "./plan.js";
import { COLLAPSED_CONTENT_IN_D2 } from "./policy.js";
import type { CollapsedPolicy, NodeLike } from "./types.js";

/**
 * The converter of D2 and of the pruned output: ONE `turndown` (+ GFM plugin) configuration, run in Node over a jsdom
 * DOM of the snapshot's stored html. Options are turndown's defaults except `headingStyle: "atx"`; images are
 * `![alt]()` (no URL, so no data URI either). Elements are removed or stripped of their own text following
 * `planPage` (the decisions come from the node table; `data-gp-id` is the join key between the markup and the table).
 *
 * Versions of turndown, the plugin and the tokenizer are pinned in package.json and read by `converterVersions()`.
 */

export const TURNDOWN_OPTIONS = { headingStyle: "atx" } as const;

let service: TurndownService | undefined;

function turndown(): TurndownService {
  if (service) return service;
  const td = new TurndownService({ ...TURNDOWN_OPTIONS });
  td.use(gfm);
  // `![alt]()`: turndown's own cleaning of the alt text, no src, no title; the same for every <img>, even a decorative one.
  td.addRule("gp-img-without-url", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = (node as unknown as Element).getAttribute("alt");
      return `![${alt ? alt.replace(/(\n+\s*)+/g, "\n") : ""}]()`;
    },
  });
  service = td;
  return td;
}

const idxOf = (el: Element): number => {
  const id = el.getAttribute("data-gp-id");
  return id !== null && /^n\d+$/.test(id) ? Number(id.slice(1)) : -1;
};

export interface ConvertOptions {
  /** Collapsed disclosures (default `"exclude"`, see `CollapsedPolicy` and the README). */
  collapsed?: CollapsedPolicy;
  /** Units to keep (element idx). Absent / null: the whole page (D2). A set (possibly empty): the pruned output. */
  keep?: ReadonlySet<number> | null;
}

export interface Converted {
  markdown: string;
  /** Elements of the document that carry no valid `data-gp-id` (late, unstamped). They follow their parent's decision. */
  unstamped: number;
}

/**
 * A page parsed once, converted many times (D2, D2 with collapsed content, one pruned output per system). The parse
 * is of the html as stored: nothing in it is executed and nothing is fetched (jsdom without `runScripts` or resources).
 */
export class PageDom {
  private readonly dom: JSDOM;
  private readonly body: HTMLElement;

  constructor(
    storedHtml: string,
    private readonly nodes: readonly NodeLike[],
  ) {
    this.dom = new JSDOM(storedHtml, { contentType: "text/html" });
    this.body = this.dom.window.document.body;
  }

  /** Markdown of the page restricted by the plan. Does not modify the parsed document (works on a clone of `<body>`). */
  convert(opts: ConvertOptions = {}): Converted {
    const plan = planPage(this.nodes, { collapsed: opts.collapsed ?? COLLAPSED_CONTENT_IN_D2, keep: opts.keep ?? null });
    const pruned = opts.keep !== undefined && opts.keep !== null;
    const root = this.body.cloneNode(true) as HTMLElement;
    const actOf = new Map<Element, Act>();
    let unstamped = 0;
    const elements: Element[] = [root, ...Array.from(root.querySelectorAll("*"))];
    for (const el of elements) {
      const idx = idxOf(el);
      let act: Act;
      if (idx >= 0 && idx < plan.act.length) {
        act = plan.act[idx] as Act;
      } else {
        unstamped++;
        const parent = el.parentElement ? actOf.get(el.parentElement) : undefined;
        // Pruned: an element nothing knows about survives only inside content that was kept in full. Whole page: as its parent.
        act = parent === undefined ? ACT_DROP : pruned ? (parent === ACT_FULL ? ACT_FULL : ACT_DROP) : parent;
      }
      actOf.set(el, act);
      if (act === ACT_DROP) {
        if (el !== root) el.remove();
        continue;
      }
      if (act === ACT_CONTAINER) {
        for (const child of Array.from(el.childNodes)) if (child.nodeType === 3 && (child.nodeValue ?? "").trim() !== "") el.removeChild(child);
      }
      // The join key has done its job. Turndown (GFM plugin) keeps the raw HTML of a table without a heading row, and
      // that HTML must not carry our bookkeeping (it would be counted, and it is not page content).
      for (const attr of Array.from(el.attributes)) if (attr.name.startsWith("data-gp-")) el.removeAttribute(attr.name);
    }
    if (actOf.get(root) === ACT_DROP) return { markdown: "", unstamped };
    return { markdown: turndown().turndown(root), unstamped };
  }

  dispose(): void {
    this.dom.window.close();
  }
}

/** One-shot D2 / pruned conversion (parses the page for this call only). */
export function htmlToMarkdown(storedHtml: string, nodes: readonly NodeLike[], opts: ConvertOptions = {}): Converted {
  const page = new PageDom(storedHtml, nodes);
  try {
    return page.convert(opts);
  } finally {
    page.dispose();
  }
}
