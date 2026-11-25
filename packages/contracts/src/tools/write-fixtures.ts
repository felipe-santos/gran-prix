/**
 * (Re)generates `fixtures/valid/**` and `fixtures/invalid/**` from the builders
 * in `tools/fixtures/`. Fixtures are COMMITTED and treated as frozen once a
 * contract version ships (cross-version tests rely on them): run this only
 * when you bump a contract's MAJOR or add a contract, and review the diff.
 *
 *   node dist/tools/write-fixtures.js
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInvalidCases } from "./fixtures/invalid.js";
import { buildUniverse, validFiles } from "./fixtures/universe.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const universe = buildUniverse();

function put(rel: string, data: string | Uint8Array): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}

rmSync(join(root, "valid"), { recursive: true, force: true });
rmSync(join(root, "invalid"), { recursive: true, force: true });

for (const [rel, data] of validFiles(universe)) put(join("valid", rel), data);

const expectations: Record<string, unknown> = {};
for (const c of buildInvalidCases(universe)) {
  put(join("invalid", c.file), `${JSON.stringify(c.doc, null, 2)}\n`);
  expectations[c.file] = { contract: c.contract, ...c.expect };
}
put(join("invalid", "expectations.json"), `${JSON.stringify(expectations, null, 2)}\n`);
console.log(`fixtures written under ${root}`);
