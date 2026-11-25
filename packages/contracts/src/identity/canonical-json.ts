/**
 * Canonical JSON per RFC 8785 (JSON Canonicalization Scheme, JCS).
 *
 * Implementation notes (full JCS for the JSON data model; see README "ID rules"):
 *  - Object members are sorted by the UTF-16 code units of their names (the
 *    default JS string order, which is what RFC 8785 section 3.2.3 mandates).
 *  - No insignificant whitespace.
 *  - Strings use the ECMAScript `JSON.stringify` escaping, which is exactly the
 *    JCS escaping (short escapes for \b \t \n \f \r \" \\, \u00xx for other
 *    control characters, everything else raw UTF-8).
 *  - Numbers use the ECMAScript `Number::toString` algorithm (what JS engines
 *    emit for `JSON.stringify`), as RFC 8785 section 3.2.2.3 requires.
 *    `-0` serializes as `0`.
 *
 * Strictness (we reject instead of guessing, because a hash must never depend
 * on a silent coercion):
 *  - `NaN`, `Infinity`, `-Infinity`            -> error (not JSON).
 *  - lone surrogates in strings or keys         -> error (RFC 8785 requires I-JSON).
 *  - `bigint`, `symbol`, `function`, `undefined` as array items or at top level -> error.
 *  - object members whose value is `undefined`  -> omitted (same as JSON.stringify,
 *    so optional TS fields are equivalent to absent fields).
 *  - non-plain objects (Date, Map, Set, typed arrays, class instances) -> error.
 *  - cycles / depth > 256                       -> error.
 */

export class CanonicalJsonError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(`${message} at ${path || "$"}`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

const MAX_DEPTH = 256;

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function serializeString(s: string, path: string): string {
  if (hasLoneSurrogate(s)) throw new CanonicalJsonError("lone surrogate in string", path);
  return JSON.stringify(s);
}

function serialize(value: unknown, path: string, depth: number, stack: object[]): string {
  if (depth > MAX_DEPTH) throw new CanonicalJsonError(`nesting deeper than ${MAX_DEPTH}`, path);
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return serializeString(value, path);
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`non-finite number (${String(value)})`, path);
      }
      return JSON.stringify(value); // ES Number::toString; -0 -> "0"
    case "object":
      break;
    default:
      throw new CanonicalJsonError(`unsupported type ${typeof value}`, path);
  }
  const obj = value as object;
  if (stack.includes(obj)) throw new CanonicalJsonError("circular reference", path);
  stack.push(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj)) throw new CanonicalJsonError("sparse array hole", `${path}[${i}]`);
        parts.push(serialize(obj[i], `${path}[${i}]`, depth + 1, stack));
      }
      return `[${parts.join(",")}]`;
    }
    if (!isPlainObject(obj)) {
      const name = (obj as { constructor?: { name?: string } }).constructor?.name ?? "object";
      throw new CanonicalJsonError(`unsupported non-plain object (${name})`, path);
    }
    const rec = obj as Record<string, unknown>;
    const keys = Object.keys(rec).sort(); // default sort = UTF-16 code unit order
    const parts: string[] = [];
    for (const k of keys) {
      const v = rec[k];
      if (v === undefined) continue;
      parts.push(`${serializeString(k, `${path}.${k}`)}:${serialize(v, `${path}.${k}`, depth + 1, stack)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    stack.pop();
  }
}

/** RFC 8785 canonical JSON text of `value`. Throws `CanonicalJsonError` on non-JSON input. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new CanonicalJsonError("undefined is not JSON", "");
  return serialize(value, "", 0, []);
}
