// Entry of the self-contained IIFE bundle (dist/gp-features.iife.js): inject it with
// `context.addInitScript` (document start: mutation tracking sees the whole load), `page.evaluate`, or
// as an extension content script. It installs `window.__gpFeatures` once and starts DOM-mutation tracking.
import "./api.js";
import { probe } from "./probe/probe.js";
import { settle, startTracking } from "./probe/settle.js";
import { buildFeatureSchemaV0, vectorize, vectorizeMatrix } from "./vectorize/index.js";

if (typeof window !== "undefined" && !window.__gpFeatures) {
  startTracking();
  window.__gpFeatures = { version: "0.1.0", probe, settle, vectorize, vectorizeMatrix, buildFeatureSchemaV0 };
}
