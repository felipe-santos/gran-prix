import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Of, type Sha256 } from "@gran-prix/contracts";
import { JSDOM } from "jsdom";
import { Defuddle } from "defuddle/node";
import { parseFlattened } from "@gran-prix/labels";

/**
 * Defuddle (npm `defuddle`, pinned in tools/cli/package.json) on jsdom, over the FLATTENED html of a snapshot.
 * Defuddle's output keeps no `data-gp-id` (its attribute whitelist drops it), so the result is mapped back to nodes by
 * text alignment only. Network is OFF: `useAsync` is forced to false (the default would let async extractors call
 * third-party APIs, which would make the labels depend on the web).
 */

/** The boolean switches of Defuddle's options a stage may set; everything else stays at the library default. */
export const DEFUDDLE_SWITCHES = [
  "removeExactSelectors",
  "removePartialSelectors",
  "removeHiddenElements",
  "removeLowScoring",
  "removeSmallImages",
  "standardize",
  "removeContentPatterns",
] as const;
export type DefuddleSwitch = (typeof DEFUDDLE_SWITCHES)[number];
export type DefuddleSwitches = Partial<Record<DefuddleSwitch, boolean>>;

/** Installed version: `defuddle/package.json` is not in the package's exports map, so find it from the resolved entry. */
export function defuddleVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.resolve("defuddle/node")));
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      const j = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string; version: string };
      if (j.name === "defuddle") return j.version;
    }
    const up = dirname(dir);
    if (up === dir) throw new Error("cannot find the defuddle package.json");
    dir = up;
  }
}

export const defuddleDigest = (): Sha256 => sha256Of(`defuddle@${defuddleVersion()}`);

export interface DefuddleOutput {
  text: string | null;
  title: string | null;
  error: string | null;
}

/** Text of Defuddle's content HTML: block boundaries become newlines so words of neighbouring blocks never fuse. */
function htmlToText(html: string): string {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  for (const br of Array.from(doc.querySelectorAll("br"))) br.replaceWith("\n");
  for (const el of Array.from(doc.querySelectorAll("p,div,li,tr,h1,h2,h3,h4,h5,h6,pre,blockquote,figcaption,section,article,table,ul,ol"))) el.append("\n");
  return doc.body.textContent ?? "";
}

export async function runDefuddle(html: string, url: string | undefined, switches: DefuddleSwitches = {}): Promise<DefuddleOutput> {
  try {
    const page = parseFlattened(html, url);
    const r = await Defuddle(page.doc, url, { ...switches, useAsync: false, debug: false });
    return { text: htmlToText(r.content ?? ""), title: r.title || null, error: null };
  } catch (e) {
    return { text: null, title: null, error: e instanceof Error ? e.message : String(e) };
  }
}
