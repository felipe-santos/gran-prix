import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  CONTRACTS,
  CONTRACT_NAMES,
  JSON_SCHEMA_DRAFT,
  UNENVELOPED,
  jsonSchemaOf,
  schemaFileName,
  schemaFileText,
} from "../src/index.js";
import { schemaProblems, writeSchemas } from "../src/tools/schema-files.js";

const dir = new URL("../schemas/", import.meta.url).pathname;

describe("emitted JSON Schema files", () => {
  it("there is exactly one committed file per contract and no strays", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    expect(files).toEqual(CONTRACT_NAMES.map(schemaFileName).sort());
  });

  it.each(CONTRACT_NAMES)("%s: committed file equals the generated text (not hand-edited, not stale)", (name) => {
    const p = join(dir, schemaFileName(name));
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe(schemaFileText(name));
  });

  it.each(CONTRACT_NAMES)("%s: is a self-contained draft-07 schema that Ajv (strict) compiles", (name) => {
    const schema = jsonSchemaOf(name);
    expect(schema["$schema"]).toBe(JSON_SCHEMA_DRAFT);
    expect(schema["$id"]).toBe(`urn:gran-prix:schema:${name}`);
    const ajv = new Ajv({ strict: true, allowUnionTypes: true });
    ajv.addKeyword("x-gran-prix");
    expect(() => ajv.compile(schema)).not.toThrow();
    // Self-contained: every $ref points inside the same document.
    const refs = [...JSON.stringify(schema).matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1] as string);
    for (const r of refs) expect(r.startsWith("#/"), `${name} has external $ref ${r}`).toBe(true);
  });

  it("each schema carries its contract name, format and version", () => {
    for (const c of CONTRACTS) {
      const s = jsonSchemaOf(c.name) as { "x-gran-prix": { contract: string; format: string; version: string } };
      expect(s["x-gran-prix"]).toEqual({ contract: c.name, format: c.format, version: c.version });
    }
  });

  it("enveloped contracts require format and format_version; the others do not", () => {
    for (const name of CONTRACT_NAMES) {
      const required = (jsonSchemaOf(name)["required"] ?? []) as string[];
      const enveloped = !UNENVELOPED.has(name);
      expect(required.includes("format"), name).toBe(enveloped);
      expect(required.includes("format_version"), name).toBe(enveloped);
    }
  });

  it("schema ids are unique", () => {
    const ids = CONTRACT_NAMES.map((n) => jsonSchemaOf(n)["$id"]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("pnpm check:schemas", () => {
  it("detects a hand-edited, a missing and a stray schema file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gp-schemas-"));
    try {
      writeSchemas(tmp);
      expect(schemaProblems(tmp)).toEqual([]);

      const golden = join(tmp, schemaFileName("golden"));
      writeFileSync(golden, readFileSync(golden, "utf8").replace('"abs"', '"absolute"'));
      rmSync(join(tmp, schemaFileName("content-tree")));
      writeFileSync(join(tmp, "stray.json"), "{}");
      const problems = schemaProblems(tmp);
      expect(problems).toContain("stale or hand-edited: schemas/golden.schema.json");
      expect(problems).toContain("missing: schemas/content-tree.schema.json");
      expect(problems).toContain("unexpected file: schemas/stray.json");

      // Regenerating heals everything.
      writeSchemas(tmp);
      rmSync(join(tmp, "stray.json"));
      expect(schemaProblems(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the compiled emitter passes on the committed schemas (skipped when dist/ is not built)", () => {
    const emitter = new URL("../dist/tools/emit-schemas.js", import.meta.url).pathname;
    if (!existsSync(emitter)) return;
    const out = execFileSync(process.execPath, [emitter, "--check"], { encoding: "utf8" });
    expect(out).toMatch(/schemas OK/);
  });
});
