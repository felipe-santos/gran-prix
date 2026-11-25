import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

/** `sha256:<64 lowercase hex>`: the content id type used everywhere in the contracts. */
export type Sha256 = `sha256:${string}`;

export const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

export function isSha256(v: unknown): v is Sha256 {
  return typeof v === "string" && SHA256_RE.test(v);
}

/** Throws unless `v` is a well-formed `sha256:<hex>` id. `what` names the argument in the error. */
export function assertSha256(v: unknown, what: string): asserts v is Sha256 {
  if (!isSha256(v)) throw new TypeError(`${what} must match ${SHA256_RE} (got ${JSON.stringify(v)})`);
}

/** Raw sha256 of bytes (or of the UTF-8 encoding of a string), as 64 lowercase hex characters. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** `sha256:<hex>` of raw bytes. Use for binary files such as `weights.f32le`. */
export function sha256Of(data: string | Uint8Array): Sha256 {
  return `sha256:${sha256Hex(data)}`;
}

/** sha256 hex of the RFC 8785 canonical JSON of `value` (no prefix). */
export function artifactHex(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Content id of a JSON value: `sha256:` + sha256 hex of its canonical JSON.
 *
 * This hashes `value` exactly as given. Contract-specific rules about which
 * fields are excluded (provenance, capture metadata, ...) live in
 * `contractId()`; `artifactId` is the primitive underneath.
 */
export function artifactId(value: unknown): Sha256 {
  return `sha256:${artifactHex(value)}`;
}
