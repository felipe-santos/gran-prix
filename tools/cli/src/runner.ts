import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  artifactId,
  contractId,
  pipelineRegistryIssues,
  resolveVars,
  stageCacheKey,
  validate,
  type ContractIssue,
  type PipelineSpec,
  type Provenance,
  type Sha256,
} from "@gran-prix/contracts";
import { wasmSha256 } from "@gran-prix/model";
import { readJsonFile, writeJsonAtomic } from "./fsutil.js";
import { dependenciesOf, select, topologicalOrder } from "./graph.js";
import { Ledger } from "./ledger.js";
import { dataPaths } from "./paths.js";
import { StageRegistry, implVersion, type StageContext, type StageLedger, type StageOutputs, type StagePlugin } from "./stage.js";
import { DEMO_STAGES } from "./stages/demo.js";
import { ArtifactStore, type ArtifactHandle } from "./store.js";
import { PipelineValidationError, type CacheEntry, type PortIds, type RunSummary, type StageReceipt, type StageResult, type StageStatus } from "./types.js";
import { GP_VERSION } from "./version.js";

type Stage = PipelineSpec["stages"][number];

export interface RunOptions {
  /** Data directory (artifacts, cache, runs, ledger). Tests pass a temp dir. */
  dataDir: string;
  /** Stage implementations (default: the demo stages). */
  plugins?: readonly StagePlugin[];
  /** Run this stage and everything downstream of it; upstream stages come from the cache. */
  from?: string;
  /** Run up to and including this stage. */
  to?: string;
  /** Re-run every selected stage even on a cache hit (cache entries are rewritten). */
  force?: boolean;
  /** Hard cap of the ledger in USD (default 0: nothing paid runs). */
  budgetUSD?: number;
  runId?: string;
  /** Base directory of relative `externals[].path` (default: the current directory). */
  root?: string;
  /** sha256 of the WASM binary for `node+wasm` stages (default: the one `@gran-prix/model` loads). */
  wasmSha?: () => Sha256;
  now?: () => Date;
  /** Called as each stage settles (for live progress). */
  onStage?: (result: StageResult) => void;
  /** Messages stages log through `ctx.log`. */
  log?: (stageId: string, message: string) => void;
}

export type PipelineCheck = { ok: true; spec: PipelineSpec } | { ok: false; issues: ContractIssue[] };

/** Contract validation of the spec plus the registry-aware checks (impl known, params schema, ports, types, seeds). */
export function checkPipeline(raw: unknown, registry: StageRegistry): PipelineCheck {
  const r = validate("pipeline-spec", raw);
  if (!r.ok) return { ok: false, issues: r.issues };
  const issues = pipelineRegistryIssues(r.value, registry.specs());
  return issues.length > 0 ? { ok: false, issues } : { ok: true, spec: r.value };
}

const errorName = (e: unknown): string => (e instanceof Error ? e.name : "Error");
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Prepared {
  stage: Stage;
  plugin: StagePlugin;
  params: Record<string, unknown>;
  paramsSha: Sha256;
  inputIds: PortIds;
  cacheKey: Sha256;
  wasmSha?: Sha256;
}

export async function runPipeline(raw: unknown, opts: RunOptions): Promise<RunSummary> {
  const registry = new StageRegistry(opts.plugins ?? DEMO_STAGES);
  const checked = checkPipeline(raw, registry);
  if (!checked.ok) throw new PipelineValidationError(checked.issues);
  return new Run(checked.spec, registry, opts).execute();
}

class Run {
  private readonly now: () => Date;
  private readonly store: ArtifactStore;
  private readonly ledger: Ledger;
  private readonly paths: ReturnType<typeof dataPaths>;
  private readonly runId: string;
  private readonly runDir: string;
  private readonly specId: Sha256;
  private readonly outputs = new Map<string, PortIds>();
  private readonly results = new Map<string, StageResult>();
  private readonly bad = new Set<string>(); // failed or skipped
  private readonly externals = new Map<string, Sha256>();
  private abortedBy: string | undefined;
  private wasm: Sha256 | undefined;

  constructor(
    private readonly spec: PipelineSpec,
    private readonly registry: StageRegistry,
    private readonly opts: RunOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
    this.paths = dataPaths(opts.dataDir);
    this.store = new ArtifactStore(this.paths.artifacts);
    this.ledger = new Ledger(this.paths.ledger, opts.budgetUSD ?? 0, this.now);
    this.runId = opts.runId ?? `run-${this.now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
    this.runDir = join(this.paths.runs, this.runId);
    this.specId = contractId("pipeline-spec", this.spec as unknown as Record<string, unknown>);
  }

  async execute(): Promise<RunSummary> {
    const order = topologicalOrder(this.spec);
    const sel = select(this.spec, this.opts.from, this.opts.to);
    const stageOf = new Map(this.spec.stages.map((s) => [s.id, s]));
    writeJsonAtomic(join(this.runDir, "pipeline.json"), this.spec);

    for (const id of order) {
      const stage = stageOf.get(id) as Stage;
      if (sel.frozen.has(id)) this.settle(await this.frozen(stage));
      else if (sel.active.has(id)) this.settle(await this.active(stage));
      else this.settle(this.result(stage, "out-of-range"));
    }

    const stages = order.map((id) => this.results.get(id) as StageResult);
    const counts: Record<StageStatus, number> = { ran: 0, cached: 0, failed: 0, skipped: 0, "out-of-range": 0 };
    for (const s of stages) counts[s.status]++;
    const summary: RunSummary = {
      runId: this.runId,
      pipeline: this.spec.name,
      specId: this.specId,
      ok: counts.failed === 0,
      stages,
      counts,
      dir: this.runDir,
    };
    writeJsonAtomic(join(this.runDir, "run.json"), {
      format: "gran-prix.run-summary",
      format_version: "1.0.0",
      run_id: this.runId,
      pipeline: this.spec.name,
      pipeline_spec_id: this.specId,
      from: this.opts.from,
      to: this.opts.to,
      force: this.opts.force === true,
      budget_usd: this.ledger.capUSD,
      finished_at: this.now().toISOString(),
      ok: summary.ok,
      counts,
      stages: stages.map((s) => ({ stage_id: s.stageId, status: s.status, cache_key: s.cacheKey, outputs: s.outputs })),
    });
    return summary;
  }

  // ----------------------------------------------------------------- stages

  /** A stage outside --from/--to whose outputs are needed: cache only, never executed. */
  private async frozen(stage: Stage): Promise<StageResult> {
    const blocked = this.blockedBy(stage);
    if (blocked) return this.skip(stage, `upstream stage "${blocked}" did not produce its outputs`);
    const started = this.now();
    let p: Prepared;
    try {
      p = this.prepare(stage);
    } catch (e) {
      return this.fail(stage, e, started, undefined, "use");
    }
    const hit = this.lookup(p.cacheKey);
    if (!hit) {
      const e = new Error(`stage "${stage.id}" is outside --from/--to and has no cached output for its current inputs and params; run it first (without --from)`);
      return this.fail(stage, e, started, p, "use");
    }
    return this.finish(stage, "cached", started, p, hit.outputs, 0, "use");
  }

  private async active(stage: Stage): Promise<StageResult> {
    if (this.abortedBy) return this.skip(stage, `run aborted by gate stage "${this.abortedBy}"`);
    const blocked = this.blockedBy(stage);
    if (blocked) return this.skip(stage, `upstream stage "${blocked}" ${this.results.get(blocked)?.status === "failed" ? "failed" : "was skipped"}`);

    const started = this.now();
    const mode: "use" | "refresh" | "off" = this.opts.force && stage.cache !== "off" ? "refresh" : (stage.cache ?? "use");
    let p: Prepared;
    try {
      p = this.prepare(stage);
    } catch (e) {
      return this.fail(stage, e, started, undefined, mode);
    }
    if (mode === "use") {
      const hit = this.lookup(p.cacheKey);
      if (hit) return this.finish(stage, "cached", started, p, hit.outputs, 0, mode);
    }

    let spent = 0;
    const t0 = performance.now();
    try {
      const outputs = await p.plugin.run(this.context(p, (c) => (spent += c)));
      const duration = Math.round(performance.now() - t0);
      const ids = this.storeOutputs(p, outputs, duration);
      if (mode !== "off") this.writeCache(p, ids);
      return this.finish(stage, "ran", started, p, ids, spent, mode, duration);
    } catch (e) {
      return this.fail(stage, e, started, p, mode, spent, Math.round(performance.now() - t0));
    }
  }

  private fail(stage: Stage, e: unknown, started: Date, p: Prepared | undefined, mode: "use" | "refresh" | "off", spent = 0, duration?: number): StageResult {
    this.bad.add(stage.id);
    if (stage.gate === true) this.abortedBy = stage.id;
    const finished = this.now();
    this.writeReceipt(stage, p, {
      status: "failed",
      cache_hit: false,
      cache_mode: mode,
      outputs: [],
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
      duration_ms: duration ?? Math.max(0, finished.getTime() - started.getTime()),
      cost_usd: spent,
      error: { name: errorName(e), message: errorMessage(e) },
    });
    return this.result(stage, "failed", { cacheKey: p?.cacheKey, costUSD: spent, durationMs: duration ?? 0, error: `${errorName(e)}: ${errorMessage(e)}` });
  }

  private skip(stage: Stage, reason: string): StageResult {
    this.bad.add(stage.id);
    const now = this.now().toISOString();
    this.writeReceipt(stage, undefined, {
      status: "skipped",
      cache_hit: false,
      cache_mode: stage.cache ?? "use",
      outputs: [],
      started_at: now,
      finished_at: now,
      duration_ms: 0,
      cost_usd: 0,
      reason,
    });
    return this.result(stage, "skipped", { reason });
  }

  private finish(
    stage: Stage,
    status: "ran" | "cached",
    started: Date,
    p: Prepared,
    ids: PortIds,
    spent: number,
    mode: "use" | "refresh" | "off",
    duration?: number,
  ): StageResult {
    this.outputs.set(stage.id, ids);
    const finished = this.now();
    const dur = duration ?? Math.max(0, finished.getTime() - started.getTime());
    this.writeReceipt(stage, p, {
      status,
      cache_hit: status === "cached",
      cache_mode: mode,
      outputs: flatten(ids),
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
      duration_ms: dur,
      cost_usd: spent,
    });
    return this.result(stage, status, { cacheKey: p.cacheKey, outputs: ids, durationMs: dur, costUSD: spent });
  }

  // ---------------------------------------------------------------- helpers

  private settle(r: StageResult): void {
    this.results.set(r.stageId, r);
    if (r.status !== "out-of-range") this.opts.onStage?.(r);
  }

  private result(stage: Stage, status: StageStatus, extra: Partial<StageResult> = {}): StageResult {
    return { stageId: stage.id, kind: stage.kind, impl: stage.impl, status, outputs: {}, durationMs: 0, costUSD: 0, ...extra };
  }

  private blockedBy(stage: Stage): string | undefined {
    for (const d of dependenciesOf(stage)) if (this.bad.has(d)) return d;
    return undefined;
  }

  /** Resolves params and input ids, then the cache key. Throws on a missing external. */
  private prepare(stage: Stage): Prepared {
    const plugin = this.registry.get(stage.impl) as StagePlugin;
    const params = resolveVars(stage.params, this.spec.vars) as Record<string, unknown>;
    const inputIds: PortIds = {};
    for (const [port, v] of Object.entries(stage.inputs)) {
      const ids = (Array.isArray(v) ? v : [v]).map((ref) => ("external" in ref ? this.external(ref.external) : this.upstream(ref.stage, ref.output)));
      inputIds[port] = Array.isArray(v) ? ids : (ids[0] as Sha256);
    }
    const wasmSha = plugin.spec.runtime === "node+wasm" ? (this.wasm ??= (this.opts.wasmSha ?? wasmSha256)()) : undefined;
    const cacheKey = stageCacheKey({ impl: stage.impl, kind: stage.kind, params, inputIds, ...(wasmSha ? { wasmSha } : {}) });
    return { stage, plugin, params, paramsSha: artifactId(params), inputIds, cacheKey, ...(wasmSha ? { wasmSha } : {}) };
  }

  private upstream(stageId: string, port: string): Sha256 {
    const ids = this.outputs.get(stageId)?.[port];
    if (ids === undefined || Array.isArray(ids)) throw new Error(`stage "${stageId}" has no single output "${port}" available`);
    return ids;
  }

  private external(name: string): Sha256 {
    const known = this.externals.get(name);
    if (known) return known;
    const ext = (this.spec.externals ?? {})[name];
    if (!ext) throw new Error(`external "${name}" is not declared`);
    let id: Sha256 | undefined;
    if (ext.path !== undefined) {
      const file = isAbsolute(ext.path) ? ext.path : resolve(this.opts.root ?? process.cwd(), ext.path);
      if (!existsSync(file)) throw new Error(`external "${name}": file ${file} does not exist`);
      const bytes = new Uint8Array(readFileSync(file));
      id = file.endsWith(".json")
        ? this.store.putJson(ext.type, JSON.parse(new TextDecoder().decode(bytes)))
        : this.store.putFiles(ext.type, { [basename(file)]: bytes });
      if (ext.id !== undefined && ext.id !== id) throw new Error(`external "${name}": ${ext.path} hashes to ${id}, the spec pins ${ext.id}`);
    } else if (ext.id !== undefined) {
      if (!this.store.has(ext.id)) throw new Error(`external "${name}": artifact ${ext.id} is not in the store`);
      id = ext.id;
    } else {
      throw new Error(`external "${name}" has neither a path nor an id`);
    }
    this.externals.set(name, id);
    return id;
  }

  private context(p: Prepared, addCost: (usd: number) => void): StageContext {
    const stage = p.stage;
    const ledger: StageLedger = {
      capUSD: this.ledger.capUSD,
      remainingUSD: () => this.ledger.remainingUSD(),
      reserve: (cost, note) => {
        const r = this.ledger.reserve(cost, { run_id: this.runId, stage_id: stage.id, ...(note ? { note } : {}) });
        return {
          id: r.id,
          costUSD: r.costUSD,
          release: () => r.release(),
          commit: (actual) => {
            r.commit(actual);
            addCost(actual ?? r.costUSD);
          },
        };
      },
    };
    const portType = (port: string) => p.plugin.spec.inputs.find((i) => i.name === port)?.type as ArtifactHandle["type"];
    const inputs: Record<string, ArtifactHandle | ArtifactHandle[]> = {};
    for (const [port, ids] of Object.entries(p.inputIds)) {
      inputs[port] = Array.isArray(ids) ? ids.map((id) => this.store.handle(id, portType(port))) : this.store.handle(ids, portType(port));
    }
    return {
      runId: this.runId,
      stageId: stage.id,
      kind: stage.kind,
      impl: stage.impl,
      params: p.params,
      inputs,
      ledger,
      dataDir: this.opts.dataDir,
      log: (m) => this.opts.log?.(stage.id, m),
    };
  }

  private storeOutputs(p: Prepared, out: StageOutputs, durationMs: number): PortIds {
    const spec = p.plugin.spec;
    const known = new Set(spec.outputs.map((o) => o.name));
    for (const k of Object.keys(out)) if (!known.has(k)) throw new Error(`stage "${p.stage.id}" returned unknown output port "${k}"`);
    const provenance = this.provenance(p, durationMs);
    const ids: PortIds = {};
    for (const port of spec.outputs) {
      const v = out[port.name];
      if (v === undefined) {
        if (port.optional) continue;
        throw new Error(`stage "${p.stage.id}" did not produce output port "${port.name}"`);
      }
      if (Array.isArray(v) !== (port.many === true)) {
        throw new Error(`stage "${p.stage.id}": output port "${port.name}" ${port.many ? "is `many` and needs an array" : "takes a single value, got an array"}`);
      }
      ids[port.name] = Array.isArray(v) ? v.map((x) => this.store.put(port.type, x, provenance)) : this.store.put(port.type, v, provenance);
    }
    return ids;
  }

  private provenance(p: Prepared, durationMs: number): Provenance {
    return {
      produced_by: {
        run_id: this.runId,
        stage_id: p.stage.id,
        kind: p.stage.kind,
        impl: p.stage.impl,
        params_sha256: p.paramsSha,
        cache_key: p.cacheKey,
      },
      inputs: flatten(p.inputIds).map(({ port, artifact_id }) => ({ port, artifact_id })),
      pipeline_spec_id: this.specId,
      tool_versions: { gp_cli: GP_VERSION, node: process.version, ...(p.wasmSha ? { wasm_sha256: p.wasmSha } : {}) },
      created_at: this.now().toISOString(),
      duration_ms: durationMs,
    };
  }

  // ------------------------------------------------------------- cache, receipts

  private cachePath(key: Sha256): string {
    return join(this.paths.cache, `${key.replace(":", "-")}.json`);
  }

  /** A cache entry whose artifacts are all still in the store; otherwise a miss. */
  private lookup(key: Sha256): CacheEntry | undefined {
    const file = this.cachePath(key);
    if (!existsSync(file)) return undefined;
    try {
      const entry = readJsonFile<CacheEntry>(file);
      const all = Object.values(entry.outputs).flat();
      return entry.cache_key === key && all.every((id) => this.store.has(id)) ? entry : undefined;
    } catch {
      return undefined;
    }
  }

  private writeCache(p: Prepared, ids: PortIds): void {
    const entry: CacheEntry = {
      format: "gran-prix.cache-entry",
      format_version: "1.0.0",
      cache_key: p.cacheKey,
      stage_id: p.stage.id,
      impl: p.stage.impl,
      outputs: ids,
      run_id: this.runId,
      created_at: this.now().toISOString(),
    };
    writeJsonAtomic(this.cachePath(p.cacheKey), entry);
  }

  private writeReceipt(stage: Stage, p: Prepared | undefined, r: Pick<StageReceipt, "status" | "cache_hit" | "cache_mode" | "outputs" | "started_at" | "finished_at" | "duration_ms" | "cost_usd"> & Partial<StageReceipt>): void {
    const receipt: StageReceipt = {
      format: "gran-prix.stage-receipt",
      format_version: "1.0.0",
      run_id: this.runId,
      stage_id: stage.id,
      kind: stage.kind,
      impl: stage.impl,
      impl_version: implVersion(stage.impl),
      ...(p ? { cache_key: p.cacheKey, params_sha256: p.paramsSha } : {}),
      inputs: p ? flatten(p.inputIds) : [],
      tool_versions: { gp_cli: GP_VERSION, node: process.version, ...(p?.wasmSha ? { wasm_sha256: p.wasmSha } : {}) },
      ...r,
    };
    writeJsonAtomic(join(this.runDir, stage.id, "stage.json"), receipt);
  }
}

function flatten(ids: PortIds): Array<{ port: string; artifact_id: Sha256; index?: number }> {
  const out: Array<{ port: string; artifact_id: Sha256; index?: number }> = [];
  for (const [port, v] of Object.entries(ids)) {
    if (Array.isArray(v)) v.forEach((id, index) => out.push({ port, artifact_id: id, index }));
    else out.push({ port, artifact_id: v });
  }
  return out;
}
