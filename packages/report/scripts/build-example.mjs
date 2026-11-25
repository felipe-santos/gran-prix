// Regenerates examples/example-report.html from the synthetic rich EvalReport v1.1 fixture (no sidecar).
// The golden test compares this file byte for byte with the renderer's output.
// Requires `pnpm --filter @gran-prix/report build`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderReport } from "../dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));
const html = renderReport(read("test/fixtures/rich-eval-report-v11.json"));
writeFileSync(join(root, "examples", "example-report.html"), html);
console.log(`examples/example-report.html: ${html.length} bytes`);
