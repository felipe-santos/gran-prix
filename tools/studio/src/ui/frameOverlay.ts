import type { Draft, Effective } from "../core/labels.js";
import { containsNode, type PageModel } from "../core/model.js";
import type { Flag, LabelClass, LightNode } from "../core/types.js";
import { FRAME_CSS } from "./frameStyle.js";

/**
 * Draws the labeling state over the captured page, inside the sandboxed iframe. The frame is same-origin
 * (`sandbox="allow-same-origin"`, no `allow-scripts`), so this controller sets attributes on the frame's elements
 * (outline, pattern) and keeps one absolutely positioned layer of letter badges; nothing in the page can run.
 */

export interface OverlayView {
  model: PageModel;
  nodes: readonly LightNode[];
  eff: Effective;
  /** Explicit labels (containers show a side bar). */
  explicit: Readonly<Record<string, LabelClass>>;
  flags: Readonly<Record<string, readonly Flag[]>>;
  selected: number | null;
  /** Review mode only. */
  draft: Draft | null;
  onlyDisagreements: boolean;
}

export interface OverlayHandlers {
  onSelect(idx: number): void;
  onHover(idx: number | null): void;
  onKey(ev: KeyboardEvent): void;
}

const LETTER: Record<LabelClass, string> = { main: "M", support: "S", noise: "N" };

export class FrameOverlay {
  private readonly els: Array<HTMLElement | undefined>;
  private readonly layer: HTMLElement;
  private readonly badges = new Map<number, HTMLElement>();
  private readonly seen = new Map<number, string>();
  private readonly attrCache: Array<Record<string, string | null> | undefined> = [];
  private hover: number | null = null;
  private lastSelected: number | null = null;
  private model: PageModel | null = null;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly doc: Document,
    private readonly h: OverlayHandlers,
  ) {
    const all = Array.from(doc.querySelectorAll<HTMLElement>("[data-gp-id]"));
    this.els = [];
    for (const el of all) {
      const m = /^n(\d+)$/.exec(el.getAttribute("data-gp-id") ?? "");
      if (m) this.els[Number(m[1])] = el;
    }
    const style = doc.createElement("style");
    style.id = "gp-studio-style";
    style.textContent = FRAME_CSS;
    doc.head.appendChild(style);
    this.layer = doc.createElement("div");
    this.layer.id = "gp-studio-layer";
    doc.body.appendChild(this.layer);
    this.listen();
  }

  private idxOf(target: EventTarget | null): number | null {
    let el = target instanceof (this.doc.defaultView?.Element ?? Element) ? (target as Element) : null;
    const m = this.model;
    while (el) {
      const id = el.getAttribute("data-gp-id");
      const mm = id ? /^n(\d+)$/.exec(id) : null;
      if (mm && m) {
        const i = Number(mm[1]);
        if ((m.unitsBelow[i] as number) > 0) return i; // only elements that hold something labelable are targets
      }
      el = el.parentElement;
    }
    return null;
  }

  private listen(): void {
    const on = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void, capture = false): void => {
      this.doc.addEventListener(type, fn, capture);
      this.cleanups.push(() => this.doc.removeEventListener(type, fn, capture));
    };
    on("mouseover", (e) => this.setHover(this.idxOf(e.target)));
    on("mouseleave", () => this.setHover(null));
    on(
      "click",
      (e) => {
        // The page is a picture of a page: links, buttons and forms must do nothing here.
        e.preventDefault();
        e.stopPropagation();
        const i = this.idxOf(e.target);
        if (i !== null) this.h.onSelect(i);
      },
      true,
    );
    on("keydown", (e) => this.h.onKey(e));
    const win = this.doc.defaultView;
    if (win) {
      const relayout = (): void => this.layout();
      win.addEventListener("resize", relayout);
      this.cleanups.push(() => win.removeEventListener("resize", relayout));
    }
  }

  private setHover(i: number | null): void {
    if (i === this.hover) return;
    if (this.hover !== null) this.els[this.hover]?.removeAttribute("data-gp-hover");
    this.hover = i;
    if (i !== null) this.els[i]?.setAttribute("data-gp-hover", "");
    this.h.onHover(i);
  }

  /** Opens collapsed content so that disclosure units are on screen and clickable (guide 2.3). */
  private revealDisclosures(view: OverlayView): void {
    const win = this.doc.defaultView;
    if (!win) return;
    for (const u of view.model.units) {
      if (view.model.inU[u] !== 2) continue;
      for (let el: HTMLElement | null | undefined = this.els[u]; el && el !== this.doc.body; el = el.parentElement) {
        if (el.hasAttribute("data-gp-forced")) continue;
        if (el.hidden || win.getComputedStyle(el).display === "none") {
          el.removeAttribute("hidden");
          el.setAttribute("data-gp-forced", "");
        }
      }
    }
  }

  /** Re-applies the whole state. Only attributes whose value changed are written. */
  render(view: OverlayView, opts: { scroll?: boolean } = {}): void {
    const first = this.model === null;
    this.model = view.model;
    if (first) this.revealDisclosures(view);
    const sel = view.selected;
    const set = (i: number, name: string, value: string | null): void => {
      const el = this.els[i];
      if (!el) return;
      const prev = (this.attrCache[i] ??= {});
      if (prev[name] === value) return;
      prev[name] = value;
      if (value === null) el.removeAttribute(name);
      else el.setAttribute(name, value);
    };
    const m = view.model;
    for (let i = 0; i < m.n; i++) {
      const isUnit = (m.inU[i] as number) !== 0;
      const eff = view.eff.cls[i] ?? null;
      const d = view.draft?.[i] ?? null;
      const disagree = isUnit && eff !== null && d !== null && eff !== d;
      set(i, "data-gp-u", isUnit ? String(m.inU[i]) : null);
      set(i, "data-gp-cls", isUnit ? (eff ?? "none") : null);
      set(i, "data-gp-ex", !isUnit ? (view.explicit[i] ?? null) : null);
      set(i, "data-gp-dis", disagree ? "" : null);
      set(i, "data-gp-dim", view.onlyDisagreements && isUnit && !disagree ? "" : null);
      set(i, "data-gp-sel", sel === i ? "" : null);
      set(i, "data-gp-in-sel", sel !== null && i !== sel && containsNode(m, sel, i) ? "" : null);
    }
    this.renderBadges(view);
    if (opts.scroll && sel !== null && sel !== this.lastSelected) this.ensureVisible(sel);
    this.lastSelected = sel;
  }

  private renderBadges(view: OverlayView): void {
    for (const u of view.model.units) {
      const eff = view.eff.cls[u] ?? null;
      const d = view.draft?.[u] ?? null;
      const flags = view.flags[u] ?? [];
      const disagree = eff !== null && d !== null && eff !== d;
      let text: string;
      let cls: string;
      if (eff !== null) {
        text = LETTER[eff] + (disagree && d ? `≠${LETTER[d]}` : "") + (flags.includes("doubt") ? "?" : "") + (flags.includes("mixed") ? "~" : "");
        cls = `${eff}${disagree ? " dis" : ""}`;
      } else if (d !== null) {
        text = `[${LETTER[d]}]`; // the draft's proposal, not yet confirmed
        cls = "ghost";
      } else {
        text = "";
        cls = "";
      }
      if (view.model.inU[u] === 2 && text) cls += " collapsed";
      const key = `${text}|${cls}|${view.onlyDisagreements && !disagree}`;
      if (this.seen.get(u) === key) continue;
      this.seen.set(u, key);
      let b = this.badges.get(u);
      if (!text || (view.onlyDisagreements && !disagree)) {
        if (b) b.style.display = "none";
        continue;
      }
      if (!b) {
        b = this.doc.createElement("span");
        this.layer.appendChild(b);
        this.badges.set(u, b);
        this.place(u, b);
      }
      b.style.display = "";
      b.textContent = text;
      b.className = cls;
    }
  }

  private place(u: number, b: HTMLElement): void {
    const el = this.els[u];
    const win = this.doc.defaultView;
    if (!el || !win) return;
    const r = el.getBoundingClientRect();
    b.style.left = `${Math.round(r.left + win.scrollX)}px`;
    b.style.top = `${Math.round(r.top + win.scrollY)}px`;
  }

  /** Recomputes the badge positions (the page reflows when images/fonts settle or the window resizes). */
  layout(): void {
    for (const [u, b] of this.badges) this.place(u, b);
  }

  private ensureVisible(i: number): void {
    const el = this.els[i];
    const win = this.doc.defaultView;
    if (!el || !win) return;
    const r = el.getBoundingClientRect();
    if (r.top < 40 || r.bottom > win.innerHeight - 40) el.scrollIntoView({ block: "center", inline: "nearest" });
  }

  destroy(): void {
    for (const c of this.cleanups.splice(0)) c();
    this.layer.remove();
    this.doc.getElementById("gp-studio-style")?.remove();
  }
}
