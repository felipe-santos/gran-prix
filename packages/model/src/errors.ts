/**
 * The nine loader checks of ADR-003, in execution order. A failure names the
 * check by number and by id; nothing is repaired and nothing is skipped.
 */
export const CHECKS = [
  { n: 1, id: "manifest", title: "model.json validates against the contracts" },
  { n: 2, id: "files", title: "every referenced file exists with its declared size" },
  { n: 3, id: "digests", title: "weights.f32le and golden.json match their sha256" },
  { n: 4, id: "network-def-digest", title: "network_def digest equals the RFC 8785 hash of the parsed network_def.json" },
  { n: 5, id: "network-def-valid", title: "validateNetworkDef (WASM) accepts the network" },
  { n: 6, id: "dimensions", title: "input/output dimensions agree with feature_spec and output_spec" },
  { n: 7, id: "weights-layout", title: "weights length and layout equal weightCount / paramShapes" },
  { n: 8, id: "round-trip", title: "Trainer.fromNetworkDef + import_weights + networkDefJson() reproduces network_def.json" },
  { n: 9, id: "golden", title: "golden.json reproduces through the WASM Trainer and infer-ts" },
] as const;

export type CheckId = (typeof CHECKS)[number]["id"];
export type CheckNumber = (typeof CHECKS)[number]["n"];

export function checkInfo(id: CheckId): (typeof CHECKS)[number] {
  const found = CHECKS.find((c) => c.id === id);
  if (!found) throw new Error(`unknown check id ${id}`);
  return found;
}

/** Thrown by `loadModelPackage` when one of the nine checks fails. */
export class ModelPackageError extends Error {
  readonly check: CheckId;
  readonly checkNumber: CheckNumber;
  /** One line per finding (first one is also in `message`). */
  readonly details: readonly string[];
  readonly dir: string;

  constructor(check: CheckId, dir: string, details: string | readonly string[], options?: { cause?: unknown }) {
    const info = checkInfo(check);
    const list = typeof details === "string" ? [details] : [...details];
    const first = list[0] ?? "failed";
    super(
      `model package check ${info.n}/9 "${info.id}" failed (${dir}): ${first}${list.length > 1 ? ` (+${list.length - 1} more)` : ""}`,
      options,
    );
    this.name = "ModelPackageError";
    this.check = check;
    this.checkNumber = info.n;
    this.details = list;
    this.dir = dir;
  }
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
