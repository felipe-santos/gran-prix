import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrainConfig } from "@gran-prix/contracts";
import { loadModelPackage } from "@gran-prix/model";
import { foldFiles, type DevData } from "./data.js";

/** Runs `gp-train train` (async, so several fits run at once) and loads the package it wrote. */

export interface FitProvenance {
  runId: string;
  stageId: string;
  cacheKey: string;
  pipelineSpecId: string;
  createdAt: string;
  name?: string;
  taskName?: string;
}

const MAX_OUTPUT = 64 * 1024 * 1024;

export function requireBinary(path: string): string {
  if (!existsSync(path)) throw new Error(`gp-train binary not found at ${path}; build it first: cargo build --release -p gp-train (or point GP_TRAIN_BIN at the binary)`);
  return path;
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

function exec(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env["SOURCE_DATE_EPOCH"]; // created_at is explicit
    const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => {
      if (out.length < MAX_OUTPUT) out += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      if (err.length < MAX_OUTPUT) err += b.toString("utf8");
    });
    child.on("error", (e) => reject(new Error(`cannot run ${binary}: ${e.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) resolve(out);
      else reject(new Error(`gp-train exited with ${String(code ?? signal)}: ${(err || out).trim().slice(-2000)}`));
    });
  });
}

/** Scores `rows` (raw features) with the package in `dir`, chunk by chunk: P(keep) per row. */
export function predictRows(dir: string, dev: DevData, rows: readonly number[], chunk = 4096): Float64Array {
  const model = loadModelPackage(dir, { runtime: "ts" });
  try {
    if (model.inputDim !== dev.dim) throw new Error(`the package takes ${model.inputDim} features, the dataset has ${dev.dim}`);
    const positive = model.outputDim === 1 ? 0 : model.labels.indexOf("keep");
    if (positive < 0) throw new Error(`the package's labels [${model.labels.join(", ")}] have no "keep"`);
    const out = new Float64Array(rows.length);
    const dim = dev.dim;
    for (let start = 0; start < rows.length; start += chunk) {
      const n = Math.min(chunk, rows.length - start);
      const x = new Float64Array(n * dim);
      for (let r = 0; r < n; r++) x.set(dev.x.subarray((rows[start + r] as number) * dim, ((rows[start + r] as number) + 1) * dim), r * dim);
      const p = model.predictBatch(x, n);
      for (let r = 0; r < n; r++) out[start + r] = p[r * model.outputDim + positive] as number;
    }
    return out;
  } finally {
    model.dispose();
  }
}

export interface FitResult {
  /** Files of the ModelPackage the trainer wrote (name -> bytes), when `keepPackage` was set. */
  files?: Record<string, Uint8Array>;
  /** P(keep) of the `predict` rows. */
  p: Float64Array;
  /** stdout of gp-train. */
  log: string;
}

export interface FitRequest {
  binary: string;
  dev: DevData;
  config: TrainConfig;
  seed: number;
  fit: readonly number[];
  predict: readonly number[];
  keepPackage?: boolean;
  provenance: FitProvenance;
}

/** Trains `config` on the rows `fit` of dev (a fold dataset in a temp dir) and scores the rows `predict`. */
export async function fitAndPredict(req: FitRequest): Promise<FitResult> {
  if (req.fit.length === 0) throw new Error("train.cv: a fit set is empty");
  const work = mkdtempSync(join(tmpdir(), "gp-train-cv-"));
  try {
    const data = join(work, "dataset");
    const out = join(work, "model");
    mkdirSync(data);
    mkdirSync(out);
    writeFiles(data, foldFiles(req.dev, req.fit));
    const config = join(work, "train-config.json");
    writeFileSync(config, `${JSON.stringify(req.config)}\n`);
    const pv = req.provenance;
    const args = [
      "train",
      "--dataset", data,
      "--config", config,
      "--out", out,
      "--seed", String(req.seed),
      "--run-id", pv.runId,
      "--stage-id", pv.stageId,
      "--cache-key", pv.cacheKey,
      "--pipeline-spec-id", pv.pipelineSpecId,
      "--created-at", pv.createdAt,
      "--duration-ms", "0",
    ];
    if (pv.name !== undefined) args.push("--name", pv.name);
    if (pv.taskName !== undefined) args.push("--task-name", pv.taskName);
    const log = await exec(req.binary, args);
    const p = predictRows(out, req.dev, req.predict);
    const files = req.keepPackage ? Object.fromEntries(readdirSync(out).sort().map((f) => [f, new Uint8Array(readFileSync(join(out, f)))])) : undefined;
    return { ...(files ? { files } : {}), p, log };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
