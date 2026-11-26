// `nodes[].flags.disclosure` (PageSnapshot v1.1, C12): the element sits inside a COLLAPSED DISCLOSURE, that is
// content of the page that a native/ARIA control keeps out of the rendered flow until the user opens it. It is not
// rendered, but it belongs to the labelable universe U (annotation guide 2.3): "the page's own content, exposed
// in the flow by a control". Modals, popups, drawers, menus, offscreen ads and anything else that is hidden for another
// reason are NOT disclosures and never get the flag.
//
// A flagged element is either a disclosure ROOT (one of the four patterns below) or a descendant of one. The probe
// walks in pre-order, so `test(el, parentFlag)` is called with the already decided flag of the composed parent.
//
// Roots (all need the CONTAINER to be on screen, i.e. the collapse is the reason the content is not rendered):
//   (a) a child of a CLOSED <details> that is not its first <summary>. Container: the <details> is shown. Evidence: the
//       child is not visible (`checkVisibility()` is false: Chromium skips the contents of a closed <details> with
//       content-visibility:hidden, so display and rect of the child are NOT a reliable signal).
//   (b) an element listed in `aria-controls` of a control with `aria-expanded="false"`. Container: the control is shown.
//       Evidence: the element has no visible box (display:none / hidden / content-visibility, visibility:hidden, opacity:0,
//       zero-size with overflow clipping, or pushed off-screen). Popups are excluded (see `isPopupLike`): the control has
//       `aria-haspopup`, or the element is a dialog / menu / listbox / tooltip / navigation, `<dialog>`, `[popover]`,
//       `aria-modal`, `position:fixed`, or sits inside `<nav>` / a dialog / a menu.
//   (c) `role="tabpanel"` that is not visible while its tab is not selected. The tab is found by `aria-labelledby`
//       (an element with role=tab) or by a `role=tab` whose `aria-controls` names the panel. Every associated tab must
//       have `aria-selected` other than "true" and one of them must be shown. A panel with no associated tab counts only
//       when a sibling tabpanel is shown (the active one).
//   (d) `hidden="until-found"`: the element itself is visible, its contents are skipped (content-visibility:hidden).
//       Container: the parent is visible.
//
// Descendants of a root inherit the flag, EXCEPT an element whose own computed display is `none` (and, through it,
// its subtree): that is hidden for a different reason (`<p hidden>` inside a closed <details>).
//
// Not covered (documented limits): "read more" toggles without `aria-controls`, JS-only accordions without ARIA, <select>
// options, content-visibility:auto, closed shadow roots and iframes (not entered by the walk anyway), controls inside
// closed shadow trees whose `aria-controls` points across the shadow boundary (ids resolve inside one tree only).
import { byIdInTreeOf, checkVisible, clientRectOf, childrenOf, closestOf, getAttr, hasAttr, parentElementOf, tagNameOf } from "./dom.js";

const VIS = { visibilityProperty: true, opacityProperty: true } as const;
/** Roles of a controlled element that mean "popup / overlay / menu", never "page content that is collapsed". */
const POPUP_ROLES = new Set(["dialog", "alertdialog", "menu", "menubar", "listbox", "tooltip", "tree", "grid", "navigation"]);
const POPUP_ANCESTORS = 'nav, dialog, [popover], [role="navigation"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="menubar"], [aria-modal="true"]';

export interface DisclosureDetector {
  /**
   * Flag of `el`, given the flag of its composed parent (false for the root element) and what the probe has already read
   * of the element: its computed `display`, the lower-case tag of its composed parent ("" for the root), whether it has a
   * `hidden` attribute, and its captured `role` attribute. Those decide, without touching the DOM, whether the element can be
   * a disclosure root at all (patterns a, b, c, d); only then the full check below runs, on the live element.
   */
  test(el: Element, parentFlag: boolean, display: string, parentTag: string, hasHidden: boolean, role: string | undefined): boolean;
}

const roleOf = (el: Element): string => (getAttr(el, "role") ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";

function idRefs(el: Element, attr: string): Element[] {
  const v = getAttr(el, attr);
  if (!v) return [];
  const out: Element[] = [];
  for (const id of v.split(/\s+/)) {
    if (id === "") continue;
    const t = byIdInTreeOf(el, id);
    if (t) out.push(t);
  }
  return out;
}

/** On screen as the user sees it: visible per CSS (display, visibility, opacity, content-visibility), a real box, not pushed off to the left/top. */
function isShown(el: Element): boolean {
  if (!checkVisible(el, VIS)) return false;
  const r = clientRectOf(el);
  if (r.width <= 0 || r.height <= 0 || (r.width <= 1 && r.height <= 1)) return false;
  return r.right + window.scrollX > 0 && r.bottom + window.scrollY > 0;
}

/** True when the nearest ancestor that has a box is visible (an element hidden because of a hidden ancestor is not a collapse). */
function parentOk(el: Element): boolean {
  let p = parentElementOf(el);
  while (p && getComputedStyle(p).display === "contents") p = parentElementOf(p);
  return p === null || checkVisible(p, VIS);
}

/** The element has no visible box of its own: the evidence that something is keeping it closed. */
function isCollapsedBox(el: Element, cs: CSSStyleDeclaration): boolean {
  if (cs.display === "contents") return false;
  if (!checkVisible(el, VIS)) return true;
  const r = clientRectOf(el);
  if ((r.width <= 0 || r.height <= 0) && (cs.overflowX !== "visible" || cs.overflowY !== "visible")) return true; // max-height:0 accordion
  return r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0; // pushed off-screen
}

/** Overlays and menus: hidden by design, but not the page's own content (guide 2.3: modal, popup, drawer, off-canvas menu). */
function isPopupLike(control: Element, target: Element, cs: CSSStyleDeclaration): boolean {
  const haspopup = getAttr(control, "aria-haspopup");
  if (haspopup !== null && haspopup.toLowerCase() !== "false") return true;
  if (POPUP_ROLES.has(roleOf(target))) return true;
  const targetTag = tagNameOf(target);
  if (targetTag === "DIALOG" || targetTag === "NAV" || hasAttr(target, "popover")) return true;
  if (getAttr(target, "aria-modal") === "true" || cs.position === "fixed") return true;
  return closestOf(target, POPUP_ANCESTORS) !== null;
}

/**
 * `controlEls` are the elements of the composed tree that have an `aria-controls` attribute (the probe collects them while it
 * walks): the controls with aria-expanded="false" and the tabs, indexed by what they control.
 */
export function createDisclosureDetector(controlEls: readonly Element[]): DisclosureDetector {
  const controlledBy = new Map<Element, Element[]>();
  const tabsOfPanel = new Map<Element, Element[]>();
  const push = (m: Map<Element, Element[]>, k: Element, v: Element): void => {
    const l = m.get(k);
    if (l) l.push(v); else m.set(k, [v]);
  };
  for (const el of controlEls) {
    if (getAttr(el, "aria-expanded") === "false") for (const t of idRefs(el, "aria-controls")) push(controlledBy, t, el);
    if (roleOf(el) === "tab") for (const t of idRefs(el, "aria-controls")) push(tabsOfPanel, t, el);
  }

  const firstSummary = new WeakMap<Element, Element | null>();
  const summaryOf = (details: Element): Element | null => {
    let s = firstSummary.get(details);
    if (s === undefined) {
      s = null;
      for (const c of childrenOf(details)) if (tagNameOf(c) === "SUMMARY") { s = c; break; }
      firstSummary.set(details, s);
    }
    return s;
  };

  const tabsFor = (panel: Element): Element[] => {
    const set = new Set<Element>(tabsOfPanel.get(panel) ?? []);
    for (const t of idRefs(panel, "aria-labelledby")) if (roleOf(t) === "tab") set.add(t);
    return [...set];
  };

  const tabpanelCollapsed = (panel: Element): boolean => {
    const tabs = tabsFor(panel);
    if (tabs.length > 0) return tabs.every((t) => getAttr(t, "aria-selected") !== "true") && tabs.some(isShown);
    const parent = parentElementOf(panel);
    if (!parent) return false;
    for (const s of childrenOf(parent)) if (s !== panel && roleOf(s) === "tabpanel" && isShown(s)) return true;
    return false;
  };

  const isRoot = (el: Element, cs: CSSStyleDeclaration): boolean => {
    // (a) closed <details>, any child but its summary
    const p = parentElementOf(el);
    if (p && tagNameOf(p) === "DETAILS" && !hasAttr(p, "open") && summaryOf(p) !== el) {
      if (cs.display !== "none" && isShown(p) && !checkVisible(el)) return true;
    }
    // (d) hidden="until-found": the element is visible, its contents are skipped
    const hid = getAttr(el, "hidden");
    if (hid !== null && hid.toLowerCase() === "until-found" && cs.getPropertyValue("content-visibility") === "hidden" && parentOk(el)) return true;
    // (b) aria-controls of a control with aria-expanded="false"
    const controls = controlledBy.get(el);
    if (controls && isCollapsedBox(el, cs) && parentOk(el) && controls.some((c) => isShown(c) && !isPopupLike(c, el, cs))) return true;
    // (c) inactive tabpanel
    if (roleOf(el) === "tabpanel" && isCollapsedBox(el, cs) && parentOk(el) && tabpanelCollapsed(el)) return true;
    return false;
  };

  return {
    test(el, parentFlag, display, parentTag, hasHidden, role) {
      if (parentFlag) return display !== "none";
      // A superset of the elements the four patterns can accept; `isRoot` is exact on them.
      const a = parentTag === "details";
      const c = role !== undefined && (role.length >= 64 || role.toLowerCase().includes("tabpanel")); // 64 = the probe's cap on `role`
      if (!(a || hasHidden || c || controlledBy.has(el))) return false;
      return isRoot(el, getComputedStyle(el));
    },
  };
}
