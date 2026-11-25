import type { ContractIssue, Sha256 } from "@gran-prix/contracts";

/** ran: executed now. cached: reused from the cache. failed: threw. skipped: an upstream stage failed or the run aborted. out-of-range: not selected by --from/--to. */
export type StageStatus = "ran" | "cached" | "failed" | "skipped" | "out-of-range";

/** Artifact ids by port (an array for `many` ports). */
export type PortIds = Record<string, Sha256 | Sha256[]>;

/** `<data-dir>/runs/<run_id>/<stage_id>/stage.json`: one per stage per run (not part of any id). */
export interface StageReceipt {
  format: "gran-prix.stage-receipt";
  format_version: "1.0.0";
  run_id: string;
  stage_id: string;
  kind: string;
  impl: string;
  impl_version: string;
  status: Exclude<StageStatus, "out-of-range">;
  cache_key?: Sha256;
  cache_hit: boolean;
  /** `use` (default), `refresh` (also set by --force) or `off`. */
  cache_mode: "use" | "refresh" | "off";
  params_sha256?: Sha256;
  inputs: Array<{ port: string; artifact_id: Sha256; index?: number }>;
  outputs: Array<{ port: string; artifact_id: Sha256; index?: number }>;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  /** Money reserved and committed through the ledger by this stage in this run. */
  cost_usd: number;
  error?: { name: string; message: string };
  /** Why a stage was skipped. */
  reason?: string;
  tool_versions: { gp_cli: string; node: string; wasm_sha256?: Sha256 };
}

/** `<data-dir>/cache/<cache_key>.json`: maps a stage cache key to the artifacts it produced. */
export interface CacheEntry {
  format: "gran-prix.cache-entry";
  format_version: "1.0.0";
  cache_key: Sha256;
  stage_id: string;
  impl: string;
  outputs: PortIds;
  run_id: string;
  created_at: string;
}

export interface StageResult {
  stageId: string;
  kind: string;
  impl: string;
  status: StageStatus;
  cacheKey?: Sha256;
  outputs: PortIds;
  durationMs: number;
  costUSD: number;
  error?: string;
  reason?: string;
}

export interface RunSummary {
  runId: string;
  pipeline: string;
  specId: Sha256;
  ok: boolean;
  stages: StageResult[];
  counts: Record<StageStatus, number>;
  /** `<data-dir>/runs/<run_id>` */
  dir: string;
}

/** Thrown before anything runs when the pipeline spec is not valid for the registry. */
export class PipelineValidationError extends Error {
  constructor(readonly issues: readonly ContractIssue[]) {
    const first = issues[0];
    super(`pipeline is not valid: ${issues.length} issue(s); first: ${first ? `${first.path}: ${first.message}` : "?"}`);
    this.name = "PipelineValidationError";
  }
}
