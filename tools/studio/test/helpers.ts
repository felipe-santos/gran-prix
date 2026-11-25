import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel, type PageModel } from "../src/core/model.js";
import type { LightNode } from "../src/core/types.js";

const dirs: string[] = [];

export function tmpDir(prefix = "gp-studio-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

export function cleanupTmp(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/**
 * A small tree, one letter per node (pre-order), for the pure-logic tests:
 *
 *   0 html
 *   1 header            (container)
 *   2   nav             unit (own text), noise-ish
 *   3 main              (container)
 *   4   h1              unit
 *   5   div             (container)
 *   6     p             unit
 *   7       a           unit (inline link inside the paragraph)
 *   8     p             unit
 *   9 footer            unit
 *   10 aside            (container), not in U (hidden), child 11 is a hidden unit-looking node
 *   11   span           NOT in U
 */
export const SAMPLE: LightNode[] = [
  { p: -1, t: "html", x: "", u: 0 },
  { p: 0, t: "header", x: "", u: 0 },
  { p: 1, t: "nav", x: "Home About", u: 1 },
  { p: 0, t: "main", x: "", u: 0 },
  { p: 3, t: "h1", x: "Title", u: 1 },
  { p: 3, t: "div", x: "", u: 0 },
  { p: 5, t: "p", x: "Body one", u: 1 },
  { p: 6, t: "a", x: "link", u: 1 },
  { p: 5, t: "p", x: "Body two", u: 1 },
  { p: 0, t: "footer", x: "Copyright", u: 1 },
  { p: 0, t: "aside", x: "", u: 0 },
  { p: 10, t: "span", x: "hidden text", u: 0 },
];

export const sampleModel = (): PageModel => buildModel(SAMPLE);
