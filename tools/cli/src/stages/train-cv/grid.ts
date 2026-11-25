import { contractId, type LabelSource, type TrainConfig } from "@gran-prix/contracts";

/**
 * The MLP's tuning grid (protocol 7: at most 12 configurations per system, fixed BEFORE looking at any data).
 *
 * 3 hidden shapes x 2 learning rates x 2 class balances (none, positive weight 2) = 12. Everything else is fixed: ReLU, Adam, cosine schedule down
 * to lr / 20, 40 epochs, batch 256, z-score normalization fitted on the fitting rows, NO early stopping and NO
 * validation split (every row of the fitting set is used to fit, and the threshold is not chosen by the trainer: the
 * operating point tau* comes from the out-of-fold scores, protocol 6.3). A network of 64+32 hidden units has about
 * 3 700 weights (~15 KB), well inside the 100 KB budget of G5.
 *
 * The grid is code, not a parameter of the data: it never depends on a result. A pipeline may pass `params.grid_name`
 * to pick another named grid defined here (a new name is a new, declared grid), or, for tests only, `params.configs`.
 */

export interface GridPoint {
  /** Stable name, recorded in the report. */
  name: string;
  hidden: number[];
  lr: number;
  /** Weight of the positive (keep) class in the loss; `null` = no class balancing. */
  pos_weight: number | null;
}

/** Protocol 7: the tuning budget per system, the MLP included. */
export const MAX_CONFIGS = 12;

export const FIXED = {
  epochs: 40,
  batch_size: 256,
  min_lr_ratio: 1 / 20,
} as const;

const HIDDEN: readonly number[][] = [[16, 8], [32, 16], [64, 32]];
const LRS: readonly number[] = [0.01, 0.003];
const POS_WEIGHTS: ReadonlyArray<number | null> = [null, 2];

/** `dom-v0-mlp-v1`: the 12 configurations of the DOM experiment. */
export const DOM_V0_GRID: readonly GridPoint[] = HIDDEN.flatMap((hidden) =>
  LRS.flatMap((lr) => POS_WEIGHTS.map((pos_weight) => ({ name: `h${hidden.join("x")}-lr${lr}-${pos_weight === null ? "pw-none" : `pw${pos_weight}`}`, hidden: [...hidden], lr, pos_weight }))),
);

export const GRIDS: Readonly<Record<string, readonly GridPoint[]>> = { "dom-v0-mlp-v1": DOM_V0_GRID };

export function assertBudget(grid: readonly GridPoint[]): void {
  if (grid.length === 0) throw new Error("the tuning grid is empty");
  if (grid.length > MAX_CONFIGS) throw new Error(`${grid.length} configurations exceed the protocol's tuning budget of ${MAX_CONFIGS} (section 7)`);
  const names = grid.map((g) => g.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) throw new Error(`two configurations are called "${dup}"`);
}

export interface DataPolicy {
  min_confidence: number;
  allowed_sources: LabelSource[];
}

/** The TrainConfig of one grid point (contract `train-config`, engine gp-train), with its `train_config_id`. */
export function trainConfigOf(point: GridPoint, seed: number, policy: DataPolicy, threshold: number, epochs: number = FIXED.epochs): TrainConfig {
  const body = {
    format: "gran-prix.train-config" as const,
    format_version: "1.0.0" as const,
    seed,
    network: { kind: "mlp" as const, hidden: [...point.hidden], activation: "relu" as const, input_dim: "auto" as const },
    loss: "bce_logits" as const,
    optimizer: { kind: "adam" as const, lr: point.lr },
    lr_schedule: { kind: "cosine" as const, min_lr: point.lr * FIXED.min_lr_ratio },
    epochs,
    batch_size: FIXED.batch_size,
    data: {
      min_confidence: policy.min_confidence,
      allowed_sources: [...policy.allowed_sources],
      class_balance: point.pos_weight === null ? { strategy: "none" as const } : { strategy: "pos_weight" as const, pos_weight: point.pos_weight },
    },
    normalization: { kind: "zscore" as const, fit_on: "train" as const },
    threshold: { strategy: "fixed" as const, value: threshold },
    runtime: { engine: "gp-train" as const },
  };
  return { ...body, train_config_id: contractId("train-config", body as unknown as Record<string, unknown>) } as TrainConfig;
}
