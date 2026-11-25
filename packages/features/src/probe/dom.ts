// Clobber-proof DOM access for the probe.
//
// A page can shadow the properties and methods of its own elements and of `document` with named elements:
//   - a <form> with a control named `children` / `childNodes` / `tagName` / `shadowRoot` / `getAttribute` / `nodeType` / `id`
//     (HTMLFormElement has [LegacyOverrideBuiltIns]): `form.children` is then the control, not the HTMLCollection;
//   - an <img>/<form>/<embed>/<object>/<iframe> with `name="documentElement"` / `title` / `readyState` / `querySelector` /
//     `getElementById` (Document has [LegacyOverrideBuiltIns]): `document.documentElement` is then that element.
// Reading an element property the plain way throws (`el.children is not iterable`) or returns the wrong thing, so such a
// page used to make the probe fail and was impossible to snapshot (e-commerce checkout forms are the typical case).
//
// Every read of a property or method of Element / Node / Document / ShadowRoot that the probe makes on page objects goes
// through the getters and methods captured here from the prototypes. The bundle is injected at document start, before page
// scripts, so the prototypes are pristine; a page that patches them later does not affect these references.
//
// Not clobberable, so read directly: CSSStyleDeclaration (getComputedStyle result), DOMRect, NodeList / HTMLCollection
// objects (iteration), `window`, `location`, the `Text` nodes' own `nodeValue` (only guarded after a nodeType check).

type Getter<T> = (this: unknown) => T;
type AnyFn = (this: unknown, ...a: never[]) => unknown;

const inBrowser = typeof Element !== "undefined" && typeof Document !== "undefined";

function getterOf<T>(proto: object, key: string): Getter<T> {
  const d = Object.getOwnPropertyDescriptor(proto, key);
  if (!d || typeof d.get !== "function") throw new Error(`gp probe: ${key} getter not found`);
  return d.get as Getter<T>;
}
function methodOf(proto: object, key: string): AnyFn {
  const f = (proto as Record<string, unknown>)[key];
  if (typeof f !== "function") throw new Error(`gp probe: ${key} method not found`);
  return f as AnyFn;
}

const never = (): never => {
  throw new Error("gp probe: DOM accessors used outside a browser");
};

const P = inBrowser
  ? {
      tagName: getterOf<string>(Element.prototype, "tagName"),
      shadowRoot: getterOf<ShadowRoot | null>(Element.prototype, "shadowRoot"),
      children: getterOf<HTMLCollection>(Element.prototype, "children"),
      fragChildren: getterOf<HTMLCollection>(DocumentFragment.prototype, "children"),
      childNodes: getterOf<NodeList>(Node.prototype, "childNodes"),
      nodeType: getterOf<number>(Node.prototype, "nodeType"),
      nodeValue: getterOf<string | null>(Node.prototype, "nodeValue"),
      textContent: getterOf<string | null>(Node.prototype, "textContent"),
      parentElement: getterOf<Element | null>(Node.prototype, "parentElement"),
      documentElement: getterOf<Element | null>(Document.prototype, "documentElement"),
      title: getterOf<string>(Document.prototype, "title"),
      readyState: getterOf<DocumentReadyState>(Document.prototype, "readyState"),
      getAttribute: methodOf(Element.prototype, "getAttribute"),
      setAttribute: methodOf(Element.prototype, "setAttribute"),
      hasAttribute: methodOf(Element.prototype, "hasAttribute"),
      getBoundingClientRect: methodOf(Element.prototype, "getBoundingClientRect"),
      getClientRects: methodOf(Element.prototype, "getClientRects"),
      closest: methodOf(Element.prototype, "closest"),
      checkVisibility: methodOf(Element.prototype, "checkVisibility"),
      getRootNode: methodOf(Node.prototype, "getRootNode"),
      docQuerySelector: methodOf(Document.prototype, "querySelector"),
      docQuerySelectorAll: methodOf(Document.prototype, "querySelectorAll"),
      docGetElementById: methodOf(Document.prototype, "getElementById"),
      fragGetElementById: methodOf(DocumentFragment.prototype, "getElementById"),
      // `type` of a form control has an implicit default; the control itself cannot be clobbered, but read it the same way.
      controlType: {
        INPUT: getterOf<string>(HTMLInputElement.prototype, "type"),
        BUTTON: getterOf<string>(HTMLButtonElement.prototype, "type"),
        SELECT: getterOf<string>(HTMLSelectElement.prototype, "type"),
        TEXTAREA: getterOf<string>(HTMLTextAreaElement.prototype, "type"),
      } as Record<string, Getter<string>>,
    }
  : (new Proxy({}, { get: () => never }) as never);

export const tagNameOf = (el: Element): string => P.tagName.call(el);
export const shadowRootOf = (el: Element): ShadowRoot | null => P.shadowRoot.call(el);
export const childrenOf = (el: Element): HTMLCollection => P.children.call(el);
/** `children` of a ShadowRoot / DocumentFragment. */
export const rootChildrenOf = (root: ShadowRoot): HTMLCollection => P.fragChildren.call(root);
export const childNodesOf = (n: Node): NodeList => P.childNodes.call(n);
export const nodeTypeOf = (n: Node): number => P.nodeType.call(n);
export const nodeValueOf = (n: Node): string | null => P.nodeValue.call(n);
export const textContentOf = (n: Node): string | null => P.textContent.call(n);
export const parentElementOf = (n: Node): Element | null => P.parentElement.call(n);
export const rootElement = (): Element | null => P.documentElement.call(document);
export const docTitle = (): string => P.title.call(document);
export const docReadyState = (): DocumentReadyState => P.readyState.call(document);

export const getAttr = (el: Element, name: string): string | null => P.getAttribute.call(el, name as never) as string | null;
export const setAttr = (el: Element, name: string, value: string): void => void P.setAttribute.call(el, name as never, value as never);
export const hasAttr = (el: Element, name: string): boolean => P.hasAttribute.call(el, name as never) as boolean;
export const clientRectOf = (el: Element): DOMRect => P.getBoundingClientRect.call(el) as DOMRect;
export const clientRectCount = (el: Element): number => (P.getClientRects.call(el) as DOMRectList).length;
export const closestOf = (el: Element, selector: string): Element | null => P.closest.call(el, selector as never) as Element | null;
export const checkVisible = (el: Element, opts?: CheckVisibilityOptions): boolean => P.checkVisibility.call(el, opts as never) as boolean;
export const rootNodeOf = (n: Node): Node => P.getRootNode.call(n) as Node;

export const queryDoc = (sel: string): Element | null => P.docQuerySelector.call(document, sel as never) as Element | null;
export const queryDocAll = (sel: string): NodeListOf<Element> => P.docQuerySelectorAll.call(document, sel as never) as NodeListOf<Element>;
/** `getElementById` of the tree `el` lives in (document or shadow root); null for detached trees. */
export function byIdInTreeOf(el: Element, id: string): Element | null {
  const root = rootNodeOf(el);
  if (nodeTypeOf(root) === 9) return P.docGetElementById.call(root, id as never) as Element | null;
  if (nodeTypeOf(root) === 11) return P.fragGetElementById.call(root, id as never) as Element | null;
  return null;
}
/** The form-control `type` property (implicit defaults included) for INPUT / BUTTON / SELECT / TEXTAREA, else null. */
export function controlTypeOf(el: Element): string | null {
  const g = P.controlType[tagNameOf(el)];
  return g ? g.call(el) : null;
}
