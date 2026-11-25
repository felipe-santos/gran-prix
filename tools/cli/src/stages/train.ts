import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Of, type Sha256 } from "@gran-prix/contracts";
import { loadModelPackage } from "@gran-prix/model";
import { defineStage, type StageContext, type StagePlugin } from "../stage.js";
import type { ArtifactHandle } from "../store.js";

/** Environment override: path of the `gp-train` binary. */
export const GP_TRAIN_ENV = "GP_TRAIN_BIN";

/** Repo root as seen from `tools/cli/{src,dist}/stages/`. */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const BUILD_HINT = "build it first: cargo build --release -p gp-train (or point GP_TRAIN_BIN at the binary)";

/**
 * Where `gp-train` lives: `$GP_TRAIN_BIN`, else `<target dir>/release/gp-train`
 * with the target dir from `$CARGO_TARGET_DIR` (relative paths resolve against
 * the repo root) or `<repo>/target`.
 */
export function defaultGpTrainPath(): string {
  const fromEnv = process.env[GP_TRAIN_ENV];
  if (fromEnv) return fromEnv;
  const target = process.env["CARGO_TARGET_DIR"];
  const dir = target ? resolve(REPO_ROOT, target) : join(REPO_ROOT, "target");
  return join(dir, "release", process.platform === "win32" ? "gp-train.exe" : "gp-train");
}

export interface TrainStageOptions {
  /** Binary location (default: `defaultGpTrainPath`). Tests point it at a copy. */
  binary?: () => string;
}

/** `created_at` of the package unless `params.created_at` says otherwise: constant, so the artifact is a pure function of its inputs. */
export const DEFAULT_CREATED_AT = "1970-01-01T00:00:00Z";

const MAX_OUTPUT = 64 * 1024 * 1024;

function requireBinary(path: string): string {
  if (!existsSync(path)) throw new Error(`gp-train binary not found at ${path}; ${BUILD_HINT}`);
  return path;
}

/** Files of a ModelPackage directory as a file-set (the loader's four files plus the training report). */
function readPackage(dir: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const name of readdirSync(dir).sort()) out[name] = new Uint8Array(readFileSync(join(dir, name)));
  return out;
}

function trainConfigOf(ctx: StageContext, dir: string): string {
  const input = ctx.inputs["config"] as ArtifactHandle | undefined;
  if (input) return join(input.dir, "content.json");
  const inline = ctx.params["config"];
  if (inline === undefined) {
    throw new Error('train needs a TrainConfig: connect the optional "config" input or pass it as params.config');
  }
  const file = join(dir, "train-config.json");
  writeFileSync(file, `${JSON.stringify(inline)}\n`);
  return file;
}

function run(binary: string, ctx: StageContext): { files: Record<string, Uint8Array> } {
  const dataset = ctx.inputs["dataset"] as ArtifactHandle;
  if (!dataset.files().includes("manifest.json")) {
    throw new Error(`dataset ${dataset.id} has no manifest.json: expected a Dataset file-set (manifest.json, train/val/test.jsonl)`);
  }
  const work = mkdtempSync(join(tmpdir(), "gp-train-"));
  try {
    const out = join(work, "model");
    mkdirSync(out);
    const config = trainConfigOf(ctx, work);
    const hex = ctx.cacheKey.slice("sha256:".length);
    const p = ctx.params;
    const args = [
      "train",
      "--dataset", join(dataset.dir, "files"),
      "--config", config,
      "--out", out,
      "--seed", String(p["seed"]),
      // The package must be a pure function of (params, inputs, binary): the real run id (and
      // the wall clock) live in the receipt and the artifact's meta.json, outside every id.
      "--run-id", `cache-${hex.slice(0, 16)}`,
      "--stage-id", ctx.stageId,
      "--cache-key", ctx.cacheKey,
      "--pipeline-spec-id", ctx.pipelineSpecId,
      "--created-at", typeof p["created_at"] === "string" ? p["created_at"] : DEFAULT_CREATED_AT,
      "--duration-ms", "0",
    ];
    if (typeof p["name"] === "string") args.push("--name", p["name"]);
    if (typeof p["task_name"] === "string") args.push("--task-name", p["task_name"]);

    ctx.log(`gp-train train --dataset ${dataset.id} --seed ${String(p["seed"])}`);
    const env = { ...process.env };
    delete env["SOURCE_DATE_EPOCH"]; // created_at is explicit
    const r = spawnSync(binary, args, { encoding: "utf8", maxBuffer: MAX_OUTPUT, env });
    if (r.error) throw new Error(`cannot run ${binary}: ${r.error.message}`);
    if (r.status !== 0) {
      throw new Error(`gp-train exited with ${String(r.status ?? r.signal)}: ${(r.stderr || r.stdout).trim().slice(-2000)}`);
    }
    for (const line of r.stdout.split("\n")) if (line.trim() !== "") ctx.log(line);

    // Nothing leaves the stage unverified: the nine checks of ADR-003 (both runtimes against golden.json).
    const model = loadModelPackage(out);
    model.dispose();
    return { files: readPackage(out) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * `rust:train.gp-train@1.0.0`: trains a ModelPackage with the offline Rust
 * trainer (ADR-007) on a Dataset artifact.
 *
 *  - Ports: `dataset: Dataset` (+ optional `config: TrainConfig`) -> `model: ModelPackage`,
 *    the canonical train ports of the registry. A TrainConfig comes from the `config`
 *    input (preferred, it is an artifact) or from `params.config`.
 *  - `params.seed` is required and overrides the seed of the TrainConfig.
 *  - The TrainConfig reaches `gp-train` as written, `sample_weight` included: `"row"` weights the loss by the
 *    Dataset's `w` column (own-text characters) and fails loudly when the dataset declares no `row_weight`.
 *  - The cache key includes the sha256 of the `gp-train` binary (`toolDigests`), so a
 *    rebuilt trainer re-runs this stage and everything downstream.
 *  - Reproducible: the run id, `created_at` and duration written to `model.json` are
 *    deterministic (cache key prefix, `params.created_at` or the epoch, 0).
 *  - The package is loaded with `loadModelPackage` (9/9) before it is accepted.
 */
export function createTrainStage(options: TrainStageOptions = {}): StagePlugin {
  const locate = options.binary ?? defaultGpTrainPath;
  const plugin = defineStage(
    {
      kind: "train",
      impl: "rust:train.gp-train@1.0.0",
      inputs: [
        { name: "dataset", type: "Dataset" },
        { name: "config", type: "TrainConfig", optional: true },
      ],
      outputs: [{ name: "model", type: "ModelPackage" }],
      params_schema: {
        type: "object",
        required: ["seed"],
        properties: {
          seed: { type: "integer", minimum: 0, maximum: 4294967295 },
          config: { type: "object", description: "TrainConfig inline; used when the `config` input is not connected." },
          name: { type: "string", minLength: 1 },
          task_name: { type: "string", minLength: 1 },
          created_at: { type: "string", description: "RFC 3339 UTC written to model.json (default: the epoch, to keep the package reproducible)." },
        },
        additionalProperties: false,
      },
      runtime: "rust",
      determinism: "seeded",
    },
    (ctx) => ({ model: run(requireBinary(locate()), ctx) }),
  );
  return {
    ...plugin,
    toolDigests: (): Record<string, Sha256> => ({
      "gp-train": sha256Of(new Uint8Array(readFileSync(requireBinary(locate())))),
    }),
  };
}

export const trainStage = createTrainStage();
