// Readability.js text extraction for U2. Usage:
//   node readability_extract.mjs '{"charThreshold":500}' < request.json
// request:  {"docs": [{"key": "...", "html": "...", "url": "..."}]}
// response: {"version": "0.6.0", "options": {...}, "results": [{"key", "text": string|null, "error": string|null}]}
// Runs on jsdom with scripts disabled (nothing executes, no resources load), as the labeler does.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";

const options = JSON.parse(process.argv[2] ?? "{}");
const req = JSON.parse(readFileSync(0, "utf8"));
const version = createRequire(import.meta.url)("@mozilla/readability/package.json").version;
const results = [];
for (const d of req.docs) {
  try {
    const dom = new JSDOM(d.html, { url: d.url || "about:blank", virtualConsole: new VirtualConsole() });
    const article = new Readability(dom.window.document, options).parse();
    results.push({ key: d.key, text: article?.textContent ?? null, error: null });
  } catch (e) {
    results.push({ key: d.key, text: null, error: String(e) });
  }
}
process.stdout.write(JSON.stringify({ version, options, results }));
