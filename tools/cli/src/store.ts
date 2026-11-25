import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  artifactId,
  canonicalJson,
  isSha256,
  sha256Of,
  type ArtifactType,
  type Provenance,
  type Sha256,
} from "@gran-prix/contracts";
import { readJsonFile, writeJsonAtomic } from "./fsutil.js";

/** What a stage emits on one output port: a JSON document, or a set of files. */
export type StageValue = { json: unknown } | { files: Readonly<Record<string, Uint8Array | string>> };

/** Read access to a stored artifact, handed to stage plugins as their inputs. */
export interface ArtifactHandle {
  readonly id: Sha256;
  readonly type: ArtifactType;
  /** Directory of the artifact inside the store. */
  readonly dir: string;
  /** The JSON document (json artifacts only). */
  json(): unknown;
  /** One file of a file-set artifact. */
  file(path: string): Uint8Array;
  /** Paths of a file-set artifact. */
  files(): string[];
}

/** `meta.json`: describes how the artifact was first produced. NEVER part of its id. */
export interface ArtifactMeta {
  format: "gran-prix.artifact-meta";
  format_version: "1.0.0";
  artifact_id: Sha256;
  kind: "json" | "files";
  type: ArtifactType;
  provenance?: Provenance;
}

const FILES_ID_VERSION = "gran-prix.files-artifact/1";

function toBytes(v: Uint8Array | string): Uint8Array {
  return typeof v === "string" ? new TextEncoder().encode(v) : v;
}

function safeRelPath(p: string): string {
  const parts = p.split("/");
  if (p === "" || p.startsWith("/") || parts.some((s) => s === "" || s === "." || s === "..") || p.includes("\\")) {
    throw new Error(`invalid artifact file path ${JSON.stringify(p)}: must be relative, without "." or ".." segments`);
  }
  return p;
}

/**
 * Content-addressed artifact store: `<root>/<sha256-hex>/` (the id with `:`
 * replaced by `-`, portable file name).
 *
 *  - JSON artifact: `content.json`; id = `artifactId(value)` (canonical JSON, RFC 8785).
 *  - File-set artifact: `files/<path>`; id = `artifactId({ v, type, files: { path: sha256 } })`
 *    (flat Merkle tree; weights and other binaries are hashed as raw bytes).
 *  - Both: `meta.json` sidecar with the provenance of the first producer.
 *
 * Writes are atomic (temp directory, then rename) and idempotent: storing the
 * same content twice keeps the first copy, so ids and bytes are stable.
 */
export class ArtifactStore {
  constructor(readonly root: string) {}

  dirOf(id: Sha256): string {
    return join(this.root, id.replace(":", "-"));
  }

  has(id: Sha256): boolean {
    return existsSync(join(this.dirOf(id), "meta.json"));
  }

  /** Stores a JSON artifact and returns its id. */
  putJson(type: ArtifactType, value: unknown, provenance?: Provenance): Sha256 {
    const id = artifactId(value);
    this.commit(id, { kind: "json", type, provenance }, (dir) => {
      writeFileSync(join(dir, "content.json"), `${canonicalJson(value)}\n`);
    });
    return id;
  }

  /** Stores a file-set artifact and returns its id. */
  putFiles(type: ArtifactType, files: Readonly<Record<string, Uint8Array | string>>, provenance?: Provenance): Sha256 {
    const entries = Object.entries(files).map(([p, c]) => [safeRelPath(p), toBytes(c)] as const);
    const id = artifactId({
      v: FILES_ID_VERSION,
      type,
      files: Object.fromEntries(entries.map(([p, b]) => [p, sha256Of(b)])),
    });
    this.commit(id, { kind: "files", type, provenance }, (dir) => {
      for (const [p, bytes] of entries) {
        const target = join(dir, "files", p);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
    });
    return id;
  }

  put(type: ArtifactType, value: StageValue, provenance?: Provenance): Sha256 {
    return "json" in value ? this.putJson(type, value.json, provenance) : this.putFiles(type, value.files, provenance);
  }

  private commit(
    id: Sha256,
    meta: { kind: "json" | "files"; type: ArtifactType; provenance: Provenance | undefined },
    fill: (dir: string) => void,
  ): void {
    if (this.has(id)) return;
    mkdirSync(this.root, { recursive: true });
    const tmp = join(this.root, `.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
    mkdirSync(tmp, { recursive: true });
    try {
      fill(tmp);
      const doc: ArtifactMeta = {
        format: "gran-prix.artifact-meta",
        format_version: "1.0.0",
        artifact_id: id,
        kind: meta.kind,
        type: meta.type,
        ...(meta.provenance ? { provenance: meta.provenance } : {}),
      };
      writeJsonAtomic(join(tmp, "meta.json"), doc);
      const dir = this.dirOf(id);
      try {
        renameSync(tmp, dir);
      } catch (e) {
        // A concurrent writer stored the same content first: keep theirs.
        if (!this.has(id)) throw e;
        rmSync(tmp, { recursive: true, force: true });
      }
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  meta(id: Sha256): ArtifactMeta {
    return readJsonFile<ArtifactMeta>(join(this.dirOf(id), "meta.json"));
  }

  handle(id: Sha256, type: ArtifactType): ArtifactHandle {
    if (!this.has(id)) throw new Error(`artifact ${id} is not in the store (${this.root})`);
    const dir = this.dirOf(id);
    return {
      id,
      type,
      dir,
      json: () => JSON.parse(readFileSync(join(dir, "content.json"), "utf8")) as unknown,
      file: (p) => new Uint8Array(readFileSync(join(dir, "files", safeRelPath(p)))),
      files: () => listFiles(join(dir, "files")),
    };
  }

  /** Recomputes the id from the stored content: true when the artifact is intact. */
  verify(id: Sha256): boolean {
    if (!this.has(id)) return false;
    const meta = this.meta(id);
    const dir = this.dirOf(id);
    try {
      if (meta.kind === "json") return artifactId(JSON.parse(readFileSync(join(dir, "content.json"), "utf8"))) === id;
      const files = Object.fromEntries(
        listFiles(join(dir, "files")).map((p) => [p, sha256Of(new Uint8Array(readFileSync(join(dir, "files", p))))]),
      );
      return artifactId({ v: FILES_ID_VERSION, type: meta.type, files }) === id;
    } catch {
      return false;
    }
  }

  /** Resolves a unique id prefix (`sha256:ab12`, `sha256-ab12` or bare hex) to a full id. */
  resolve(prefix: string): Sha256 {
    if (isSha256(prefix) && this.has(prefix)) return prefix;
    const hex = prefix.replace(/^sha256[:-]/, "");
    if (!/^[0-9a-f]{4,64}$/.test(hex)) throw new Error(`"${prefix}" is not an artifact id or a hex prefix of at least 4 characters`);
    const found = existsSync(this.root) ? readdirSync(this.root).filter((n) => n.startsWith(`sha256-${hex}`)) : [];
    if (found.length === 0) throw new Error(`no artifact matches "${prefix}"`);
    if (found.length > 1) throw new Error(`"${prefix}" is ambiguous: ${found.length} artifacts match`);
    return `sha256:${(found[0] as string).slice("sha256-".length)}`;
  }
}

function listFiles(root: string, rel = ""): string[] {
  if (!existsSync(join(root, rel))) return [];
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...listFiles(root, p));
    else out.push(p);
  }
  return out.sort();
}
