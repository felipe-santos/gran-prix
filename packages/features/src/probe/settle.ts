// Settle strategy (the in-page half). The Node driver does steps 1-2; steps 3 happens here:
//
//   1. wait for `load`                                   (driver: page.goto waitUntil "load")
//   2. best-effort networkidle, capped at 3 s            (driver; chatty pages never idle)
//   3. DOM-quiet: no childList / characterData mutation on the document or on ANY open shadow root for
//      >= quietMs (600), with document.readyState === "complete"; hard cap maxMs (8000) from the call.
//
// A 150 ms quiet window is shorter than the gap between SPA render waves and fails exactly like no wait
// at all (spike FINDINGS), hence 600 ms.
//
// Observing shadow roots WITHOUT patching Element.prototype.attachShadow (the spike's approach): a
// content script lives in an isolated world where the patch would never see the page's own calls, and
// patching the prototype is detectable by pages. Instead every open shadow root found by a composed
// walk is observed, and the walk is repeated (a) whenever the document mutated since the last walk and
// (b) at least every RESCAN_EVERY_MS. A shadow root attached to an element that is already in the
// document is discovered by the next re-walk; its discovery counts as DOM activity. Roots attached
// before insertion are found by (a) when the host is inserted. Closed roots are invisible by design.

import { childrenOf, docReadyState, rootChildrenOf, rootElement, shadowRootOf } from "./dom.js";

export interface SettleRecord {
  /** "quiet": the DOM was quiet for quietMs. "max": the hard cap was hit first. */
  reason: "quiet" | "max";
  waited_ms: number;
  /** Mutation records seen since tracking started. */
  mutations: number;
  /** Open shadow roots observed when the wait ended. */
  shadow_roots: number;
  /** True when tracking started before DOMContentLoaded (bundle injected as an init script). */
  tracked_from_start: boolean;
}

const RESCAN_EVERY_MS = 400;
const TICK_MS = 50;

interface Tracker {
  count: number;
  last: number;
  dirty: boolean;
  lastScan: number;
  observer: MutationObserver;
  roots: WeakSet<Node>;
  rootCount: number;
  fromStart: boolean;
}

let tracker: Tracker | null = null;

function observe(t: Tracker, root: Node): void {
  if (t.roots.has(root)) return;
  t.roots.add(root);
  try {
    t.observer.observe(root, { childList: true, subtree: true, characterData: true });
  } catch {
    /* detached or unobservable */
  }
}

/** Observes every open shadow root reachable through the composed tree. Returns how many were new. */
function scanShadowRoots(t: Tracker): number {
  let found = 0;
  const de = rootElement();
  const stack: Element[] = de ? [de] : [];
  while (stack.length > 0) {
    const el = stack.pop() as Element;
    const sr = shadowRootOf(el);
    if (sr) {
      if (!t.roots.has(sr)) { observe(t, sr); t.rootCount++; found++; }
      for (const c of rootChildrenOf(sr)) stack.push(c);
    }
    for (const c of childrenOf(el)) stack.push(c);
  }
  t.lastScan = performance.now();
  t.dirty = false;
  return found;
}

/** Idempotent. Call as early as possible (an init script) so mutations since document start are counted. */
export function startTracking(): void {
  if (tracker) return;
  const t: Tracker = {
    count: 0,
    last: performance.now(),
    dirty: true,
    lastScan: 0,
    roots: new WeakSet(),
    rootCount: 0,
    fromStart: docReadyState() === "loading",
    observer: new MutationObserver((list) => {
      t.count += list.length;
      t.last = performance.now();
      t.dirty = true;
    }),
  };
  tracker = t;
  observe(t, document);
}

/** Resolves once the DOM has been quiet for `quietMs` (and the document is complete) or `maxMs` elapsed. */
export function settle({ quietMs = 600, maxMs = 8000 }: { quietMs?: number; maxMs?: number } = {}): Promise<SettleRecord> {
  startTracking();
  const t = tracker as Tracker;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const tick = (): void => {
      const now = performance.now();
      if (t.dirty || now - t.lastScan >= RESCAN_EVERY_MS) {
        if (scanShadowRoots(t) > 0) {
          t.last = performance.now();
          t.count++;
        }
      }
      const finish = (reason: SettleRecord["reason"]): void =>
        resolve({ reason, waited_ms: Math.round(now - t0), mutations: t.count, shadow_roots: t.rootCount, tracked_from_start: t.fromStart });
      if (docReadyState() === "complete" && now - t.last >= quietMs) return finish("quiet");
      if (now - t0 >= maxMs) return finish("max");
      setTimeout(tick, TICK_MS);
    };
    tick();
  });
}
