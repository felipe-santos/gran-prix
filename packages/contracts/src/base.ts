import { Type, type SchemaOptions, type Static, type TLiteral, type TObject, type TProperties, type TSchema } from "@sinclair/typebox";
import type { Sha256 as Sha256Id } from "./identity/hash.js";

/** `sha256:<64 lowercase hex>`. */
export const Sha256 = Type.Unsafe<Sha256Id>(
  Type.String({ pattern: "^sha256:[0-9a-f]{64}$", description: "Content id: sha256: + 64 lowercase hex characters." }),
);

export type Sha256 = Sha256Id;

export const SemVer =Type.Unsafe<`${number}.${number}.${number}`>(
  Type.String({ pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$", description: "Semantic version x.y.z." }),
);
export type SemVer = Static<typeof SemVer>;

/** Timestamps appear only in provenance, never in hashed payloads. */
export const Iso8601 = Type.String({
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$",
  description: "RFC 3339 / ISO 8601 date-time. Provenance only.",
});

export const NonNegInt = Type.Integer({ minimum: 0 });
export const PosInt = Type.Integer({ minimum: 1 });
export const Unit01 = Type.Number({ minimum: 0, maximum: 1 });
export const Uint32 = Type.Integer({ minimum: 0, maximum: 4294967295 });
/** snake_case identifier, stable across versions. */
export const SnakeName = Type.String({ pattern: "^[a-z][a-z0-9_]*$" });
/** JSON object with arbitrary content (params, kind-specific blobs). */
export const JsonObject = Type.Record(Type.String(), Type.Unknown());

/** Reference to a file inside a multi-file artifact. */
export const FileRef = Type.Object({
  path: Type.String({ minLength: 1, description: "Path relative to the artifact directory, '/' separators, no '..'." }),
  sha256: Sha256,
  bytes: NonNegInt,
  media_type: Type.Optional(Type.String()),
  content_encoding: Type.Optional(
    Type.String({
      description:
        "v1.1: transfer encoding of the stored file, e.g. 'gzip'. `sha256` and `bytes` ALWAYS describe the DECODED content, so the compressor / zlib build never changes an id; absent = stored as is.",
    }),
  ),
});
export type FileRef = Static<typeof FileRef>;

/** Every contract document starts with `format` + `format_version`. */
export function envelope<F extends string>(format: F): { format: TLiteral<F>; format_version: typeof SemVer } {
  return { format: Type.Literal(format), format_version: SemVer };
}

/** Defines a contract object schema: `$id`, title and envelope are attached here. */
export function contractObject<F extends string, P extends TProperties>(
  name: string,
  format: F,
  props: P,
  description: string,
  extra: SchemaOptions = {},
): TObject<{ format: TLiteral<F>; format_version: typeof SemVer } & P> {
  return Type.Object(
    { ...envelope(format), ...props },
    { ...extra, $id: `urn:gran-prix:schema:${name}`, title: name, description },
  );
}

/** Contract version + schema in one value; `version` is the semver of the CONTRACT. */
export function defineContract<N extends string, S extends TSchema>(
  name: N,
  format: string,
  version: SemVer,
  schema: S,
): ContractModule<S, N> {
  return { name, format, version, schema };
}

/** Marks a schema as the one for a contract: used by the registry and the emitter. */
export interface ContractModule<S extends TSchema = TSchema, N extends string = string> {
  /** File-safe name, e.g. `feature-schema`. */
  name: N;
  /** Value of the `format` field, e.g. `gran-prix.feature-schema`. */
  format: string;
  /** Current semver of the contract. Bump per README "Versioning policy". */
  version: string;
  schema: S;
}
