// Functions that `chrome.scripting.executeScript({ func })` runs INSIDE the tab (isolated world). They are serialized
// with `Function.prototype.toString`, so each one must be self-contained: no imports, no outer variables.

/**
 * Settle + probe, the same call the collector makes (`probeLoadedPage` -> `window.__gpFeatures.probe`): DOM-quiet
 * window, `data-gp-id` stamps, the node table and text units. Also reads what only the page knows: the HTTP status of
 * the navigation (Navigation Timing `responseStatus`; 0 when the browser does not report it).
 * @param {{ quietMs: number, maxMs: number }} opts
 */
export async function pageProbe(opts) {
  const api = window.__gpFeatures;
  if (!api) throw new Error("gp-features bundle is not installed in this page");
  const raw = await api.probe({ quietMs: opts.quietMs, maxMs: opts.maxMs });
  const nav = performance.getEntriesByType("navigation")[0];
  const status = nav && typeof nav.responseStatus === "number" ? nav.responseStatus : 0;
  return { raw, status, userAgent: navigator.userAgent };
}

/** Reads (and clears) the flattened html that `flatten-page.js` (FLATTEN_SOURCE of the collect stage) left on `window`. */
export function pageTakeFlat() {
  const flat = window.__gpFlat;
  delete window.__gpFlat;
  return flat ?? null;
}
