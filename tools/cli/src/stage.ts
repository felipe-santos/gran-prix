import type { StageKindSpec } from "@gran-prix/contracts";
import type { Reservation } from "./ledger.js";
import type { ArtifactHandle, StageValue } from "./store.js";

/** The ledger as a stage sees it: bound to the stage, so entries carry run and stage ids. */
export interface StageLedger {
  /** Call BEFORE every paid call. Throws `BudgetExceededError` when the hard cap would be passed. */
  reserve(costUSD: number, note?: string): Reservation;
  readonly capUSD: number;
  remainingUSD(): number;
}

export interface StageContext {
  readonly runId: string;
  readonly stageId: string;
  readonly kind: StageKindSpec["kind"];
  readonly impl: string;
  /** `params` of the stage instance after `${vars.*}` substitution; validated against `params_schema`. */
  readonly params: Readonly<Record<string, unknown>>;
  /** Input artifacts by port (an array for `many` ports; optional unconnected ports are absent). */
  readonly inputs: Readonly<Record<string, ArtifactHandle | ArtifactHandle[]>>;
  readonly ledger: StageLedger;
  readonly dataDir: string;
  log(message: string): void;
}

/** What a stage returns: one value per output port (an array for `many` ports). */
export type StageOutputs = Record<string, StageValue | StageValue[]>;

/**
 * A stage implementation. `spec` is the registry entry (`StageKindSpec`: typed
 * ports, `params_schema`, runtime, determinism) that `gp validate` and the
 * future editor read; `run` does the work. A stage must be a function of its
 * resolved params and input artifacts (plus the WASM binary when `runtime` is
 * `node+wasm`): the cache key assumes nothing else matters. Stages that call
 * paid or external services must declare `determinism: "cached-external"` or
 * `"external"` and reserve every paid call from `ctx.ledger`.
 */
export interface StagePlugin {
  readonly spec: StageKindSpec;
  run(ctx: StageContext): Promise<StageOutputs> | StageOutputs;
}

export type StageSpecInput = Omit<StageKindSpec, "format" | "format_version">;

/** Builds a plugin, filling the contract envelope of the `StageKindSpec`. */
export function defineStage(spec: StageSpecInput, run: StagePlugin["run"]): StagePlugin {
  return {
    spec: { format: "gran-prix.stage-kind-spec", format_version: "1.0.0", ...spec },
    run,
  };
}

/** Implementation version of `ts:demo.emit-json@1.0.0` is `1.0.0`. */
export function implVersion(impl: string): string {
  const at = impl.lastIndexOf("@");
  return at < 0 ? "" : impl.slice(at + 1);
}

/** Impl-id -> plugin lookup with duplicate detection. */
export class StageRegistry {
  private readonly byImpl = new Map<string, StagePlugin>();

  constructor(plugins: readonly StagePlugin[]) {
    for (const p of plugins) {
      if (this.byImpl.has(p.spec.impl)) throw new Error(`stage implementation "${p.spec.impl}" is registered twice`);
      this.byImpl.set(p.spec.impl, p);
    }
  }

  get(impl: string): StagePlugin | undefined {
    return this.byImpl.get(impl);
  }

  specs(): StageKindSpec[] {
    return [...this.byImpl.values()].map((p) => p.spec);
  }
}
