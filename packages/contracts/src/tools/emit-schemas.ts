/**
 * Emits `schemas/<contract>.schema.json` from the TypeBox definitions.
 *
 *   node dist/tools/emit-schemas.js           write the files
 *   node dist/tools/emit-schemas.js --check   fail (exit 1) if any committed file
 *                                             differs from the generated text, is
 *                                             missing, or is not a known schema
 *
 * The files are generated artifacts: never edit them by hand.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schemaProblems, writeSchemas } from "./schema-files.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(resolve(here, "..", ".."), "schemas");

if (process.argv.includes("--check")) {
  const problems = schemaProblems(outDir);
  if (problems.length > 0) {
    console.error(`schemas are out of date:\n  ${problems.join("\n  ")}\nrun \`pnpm build\` and commit the result.`);
    process.exit(1);
  }
  console.log("schemas OK (committed files match the TypeBox definitions)");
} else {
  const { total, changed } = writeSchemas(outDir);
  console.log(`schemas: ${total} contracts, ${changed} file(s) written to schemas/`);
}
