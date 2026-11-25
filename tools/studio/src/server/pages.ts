import type { PageSnapshot } from "@gran-prix/contracts";
import { buildModel, type PageModel } from "../core/model.js";
import type { LightNode } from "../core/types.js";
import { computeUniverse } from "../core/universe.js";
import { readHtml, readSnapshot, type PageRef } from "./snapshot-set.js";

/** Everything the server derives once per (immutable) snapshot. */
export interface PageData {
  ref: PageRef;
  snapshot: PageSnapshot;
  nodes: LightNode[];
  model: PageModel;
}

const TEXT_CAP = 240;

export function lightNodes(snapshot: PageSnapshot): LightNode[] {
  const inU = computeUniverse(snapshot.nodes);
  return snapshot.nodes.map((n, i) => {
    const light: LightNode = { p: n.parent, t: n.tag, x: n.own_text.length > TEXT_CAP ? `${n.own_text.slice(0, TEXT_CAP)}…` : n.own_text, u: inU[i] as 0 | 1 | 2 };
    if (n.attrs.id) light.i = n.attrs.id.slice(0, 60);
    if (n.attrs.class) light.c = n.attrs.class.slice(0, 80);
    return light;
  });
}

export class PageCache {
  private readonly cache = new Map<string, PageData>();

  load(ref: PageRef): PageData {
    const hit = this.cache.get(ref.hex);
    if (hit) return hit;
    const snapshot = readSnapshot(ref);
    const nodes = lightNodes(snapshot);
    const data: PageData = { ref, snapshot, nodes, model: buildModel(nodes) };
    this.cache.set(ref.hex, data);
    return data;
  }
}

/**
 * The flattened html of a snapshot made safe to show in the sandboxed frame. The frame is already inert
 * (`sandbox` without allow-scripts, CSP `default-src 'none'`), so this is defence in depth plus fidelity:
 *  - `<meta http-equiv=refresh>` and `<base>` go (they would navigate the frame or redirect every relative URL);
 *  - every `<details>` is opened, so collapsed disclosure content is on screen and clickable (guide 2.3);
 *  - the doctype/charset are kept, nothing else is rewritten (no HTML parser: the text is only ever served as html
 *    into a script-less sandbox, never interpolated into the app's own DOM).
 */
export function frameHtml(html: string): string {
  return html
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<details\b(?![^>]*\sopen\b)/gi, "<details open");
}

/** CSP of the framed page: no scripts, no network, only inline styles and data: images/fonts; sandboxed to its own origin. */
export const FRAME_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-same-origin",
].join("; ");

export const readFrame = (ref: PageRef): string => frameHtml(readHtml(ref));
