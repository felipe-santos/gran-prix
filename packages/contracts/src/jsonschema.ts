import { FileRef, Iso8601, SemVer, Sha256 } from "./base.js";
import { CONTRACTS, type ContractName } from "./registry.js";

export const JSON_SCHEMA_DRAFT = "http://json-schema.org/draft-07/schema#";

export type JsonSchema = Record<string, unknown>;

const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

/**
 * Shared leaf shapes. Wherever one of them appears in a contract it is replaced
 * by a `$ref` to a `$defs` entry of the same name, so schema files stay short and
 * the Rust side gets named types (`Sha256`, `FileRef`, ...).
 */
const SHARED: Record<string, unknown> = {
  Sha256: plain(Sha256),
  SemVer: plain(SemVer),
  Iso8601: plain(Iso8601),
  FileRef: plain(FileRef),
};
const SHARED_BY_TEXT = new Map(Object.entries(SHARED).map(([name, v]) => [JSON.stringify(v), name]));

function hoistShared(node: unknown, used: Set<string>, selfName?: string): unknown {
  if (Array.isArray(node)) return node.map((n) => hoistShared(n, used, selfName));
  if (node === null || typeof node !== "object") return node;
  const name = SHARED_BY_TEXT.get(JSON.stringify(node));
  if (name !== undefined && name !== selfName) {
    used.add(name);
    return { $ref: `#/$defs/${name}` };
  }
  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, hoistShared(v, used, selfName)]),
  );
}

/**
 * Plain JSON Schema (draft-07) of a contract: TypeBox's symbol-keyed metadata is
 * dropped by the JSON round-trip. Self-contained (every `$ref` points inside the
 * same file), so non-JS consumers (the Rust side) can load a single file.
 */
export function jsonSchemaOf(name: ContractName): JsonSchema {
  const c = CONTRACTS.find((x) => x.name === name);
  if (!c) throw new Error(`unknown contract: ${name}`);
  const body = plain(c.schema) as JsonSchema;
  const { $id, $defs: ownDefs, ...rest } = body;
  const used = new Set<string>();
  const defs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((ownDefs ?? {}) as Record<string, unknown>)) defs[k] = hoistShared(v, used);
  const hoisted = hoistShared(rest, used) as JsonSchema;
  // A shared def may itself use other shared defs (FileRef -> Sha256): iterate to a fixpoint.
  for (let again = true; again; ) {
    again = false;
    for (const n of [...used]) {
      if (n in defs) continue;
      defs[n] = hoistShared(SHARED[n], used, n);
      again = true;
    }
  }
  const sortedDefs = Object.fromEntries(Object.entries(defs).sort(([x], [y]) => (x < y ? -1 : 1)));
  return {
    $schema: JSON_SCHEMA_DRAFT,
    $id,
    "x-gran-prix": { contract: c.name, format: c.format, version: c.version },
    ...(Object.keys(sortedDefs).length > 0 ? { $defs: sortedDefs } : {}),
    ...hoisted,
  };
}

const isScalar = (v: unknown): boolean => v === null || typeof v !== "object";

/**
 * Deterministic pretty printer: 2-space indent, but arrays of scalars (the
 * `required` and `enum` lists) and short flat objects stay on one line, which keeps the files short
 * enough to review.
 */
export function formatJson(value: unknown, indent = ""): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every(isScalar)) return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
    const inner = `${indent}  `;
    return `[\n${value.map((v) => `${inner}${formatJson(v, inner)}`).join(",\n")}\n${indent}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    if (entries.every(([, v]) => isScalar(v))) {
      const flat = `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`;
      if (flat.length <= 72) return flat;
    }
    const inner = `${indent}  `;
    return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatJson(v, inner)}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

/** Stable text of a schema file (see `formatJson`), with a trailing newline. */
export function schemaFileText(name: ContractName): string {
  return `${formatJson(jsonSchemaOf(name))}\n`;
}

export function schemaFileName(name: ContractName): string {
  return `${name}.schema.json`;
}
