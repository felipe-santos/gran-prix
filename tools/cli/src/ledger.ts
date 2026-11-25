import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Who is spending; recorded on every entry. */
export interface SpendContext {
  run_id?: string;
  stage_id?: string;
  /** Free text: provider/model, `llm_key`, what the money is for. */
  note?: string;
}

export type LedgerEvent =
  | ({ event: "reserve"; id: string; cost_usd: number; cap_usd: number } & SpendContext)
  | ({ event: "commit"; id: string; cost_usd: number } & SpendContext)
  | ({ event: "release"; id: string } & SpendContext)
  | ({ event: "reject"; cost_usd: number; cap_usd: number; spent_usd: number } & SpendContext);

export type LedgerEntry = LedgerEvent & { ts: string };

/** Thrown by `reserve` when the call would push the total past the hard cap. Nothing was spent. */
export class BudgetExceededError extends Error {
  constructor(
    readonly requestedUSD: number,
    readonly spentUSD: number,
    readonly capUSD: number,
  ) {
    super(
      `budget cap exceeded: reserving $${requestedUSD.toFixed(4)} on top of $${spentUSD.toFixed(4)} already spent/reserved would pass the $${capUSD.toFixed(2)} cap`,
    );
    this.name = "BudgetExceededError";
  }
}

export interface Reservation {
  readonly id: string;
  readonly costUSD: number;
  /** Records the real cost (default: the reserved amount). Call once the paid call returned. */
  commit(actualUSD?: number): void;
  /** Gives the reservation back (the paid call was not made or failed before billing). */
  release(): void;
}

const EPS = 1e-9;

/**
 * Append-only spending ledger (`ledger.jsonl`) with a HARD cap.
 *
 * A stage must `reserve(costUSD)` BEFORE every paid call; the reservation
 * throws `BudgetExceededError` (and logs a `reject` line) when
 * `spent + costUSD > cap`, so overspending is impossible by construction as
 * long as every paid call goes through here. A crashed run leaves its
 * reservation counted (conservative). Cap and total are per ledger file, i.e.
 * cumulative across runs over the same data dir. The default cap is 0: nothing
 * paid runs unless a budget is given explicitly.
 */
export class Ledger {
  constructor(
    readonly path: string,
    readonly capUSD: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isFinite(capUSD) || capUSD < 0) throw new RangeError(`budget cap must be a finite number >= 0 (got ${capUSD})`);
  }

  entries(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as LedgerEntry);
  }

  /** Committed cost plus still-open reservations. */
  spentUSD(): number {
    const effective = new Map<string, number>();
    for (const e of this.entries()) {
      if (e.event === "reserve") effective.set(e.id, e.cost_usd);
      else if (e.event === "commit") effective.set(e.id, e.cost_usd);
      else if (e.event === "release") effective.set(e.id, 0);
    }
    let total = 0;
    for (const v of effective.values()) total += v;
    return total;
  }

  remainingUSD(): number {
    return Math.max(0, this.capUSD - this.spentUSD());
  }

  private append(e: LedgerEvent): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const line: LedgerEntry = { ts: this.now().toISOString(), ...e };
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
  }

  reserve(costUSD: number, ctx: SpendContext = {}): Reservation {
    if (!Number.isFinite(costUSD) || costUSD < 0) throw new RangeError(`cost must be a finite number >= 0 (got ${costUSD})`);
    const spent = this.spentUSD();
    if (spent + costUSD > this.capUSD + EPS) {
      this.append({ event: "reject", cost_usd: costUSD, cap_usd: this.capUSD, spent_usd: spent, ...ctx });
      throw new BudgetExceededError(costUSD, spent, this.capUSD);
    }
    const id = randomBytes(6).toString("hex");
    this.append({ event: "reserve", id, cost_usd: costUSD, cap_usd: this.capUSD, ...ctx });
    let closed = false;
    return {
      id,
      costUSD,
      commit: (actualUSD = costUSD) => {
        if (closed) throw new Error(`reservation ${id} is already closed`);
        if (!Number.isFinite(actualUSD) || actualUSD < 0) throw new RangeError(`actual cost must be finite and >= 0 (got ${actualUSD})`);
        closed = true;
        this.append({ event: "commit", id, cost_usd: actualUSD, ...ctx });
      },
      release: () => {
        if (closed) throw new Error(`reservation ${id} is already closed`);
        closed = true;
        this.append({ event: "release", id, ...ctx });
      },
    };
  }
}
