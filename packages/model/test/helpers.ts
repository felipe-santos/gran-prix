import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactId, modelId, sha256Of, type Golden, type ModelPackage } from "@gran-prix/contracts";

/** The contracts' valid ModelPackage fixture (real digests, golden computed by an independent reference). */
export const FIXTURE_DIR = fileURLToPath(new URL("../../contracts/fixtures/valid/model-package", import.meta.url));

const made: string[] = [];

export function tmpDir(prefix = "gp-model-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

export function cleanupTmp(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** A scratch copy of the fixture package. */
export function copyFixture(): string {
  const d = tmpDir();
  cpSync(FIXTURE_DIR, d, { recursive: true });
  return d;
}

export const readJson = <T = unknown>(dir: string, name: string): T => JSON.parse(readFileSync(join(dir, name), "utf8")) as T;
export const writeJson = (dir: string, name: string, v: unknown): void => writeFileSync(join(dir, name), JSON.stringify(v));

export interface Edits {
  /** Replaces network_def.json (object is JSON-stringified). */
  networkDef?: unknown;
  /** Replaces weights.f32le. */
  weights?: Float32Array;
  /** Replaces golden.json. */
  golden?: Golden;
  /** Mutates model.json before it is re-sealed. */
  model?: (m: ModelPackage) => void;
}

/**
 * Applies `edits` and re-seals model.json so that ONLY the intended check can
 * notice: byte sizes, digests (network_def, weights, golden) and model_id are
 * recomputed from the files on disk.
 */
export function reseal(dir: string, edits: Edits): void {
  const m = readJson<ModelPackage>(dir, "model.json");
  if (edits.networkDef !== undefined) writeFileSync(join(dir, "network_def.json"), JSON.stringify(edits.networkDef));
  if (edits.weights) writeFileSync(join(dir, "weights.f32le"), Buffer.from(edits.weights.buffer, edits.weights.byteOffset, edits.weights.byteLength));
  if (edits.golden) writeFileSync(join(dir, "golden.json"), JSON.stringify(edits.golden));
  edits.model?.(m);
  const def = JSON.parse(readFileSync(join(dir, "network_def.json"), "utf8")) as unknown;
  const weights = new Uint8Array(readFileSync(join(dir, "weights.f32le")));
  const golden = new Uint8Array(readFileSync(join(dir, "golden.json")));
  m.files.network_def.bytes = readFileSync(join(dir, "network_def.json")).byteLength;
  m.files.weights.bytes = weights.byteLength;
  m.files.golden.bytes = golden.byteLength;
  m.digest.network_def = artifactId(def);
  m.digest.weights = sha256Of(weights);
  m.digest.golden = sha256Of(golden);
  m.model_id = modelId(m);
  writeJson(dir, "model.json", m);
}

/** Writes bytes to a package file without touching model.json (simulates corruption on disk). */
export function overwrite(dir: string, name: string, bytes: Uint8Array | string): void {
  writeFileSync(join(dir, name), bytes);
}
